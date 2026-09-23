// Measures the card's frames as it opens and closes, in headless Chrome, as a phone and as a
// desktop. Each run clicks the card open, then closed, and reads the sessions that the page's own
// meter records with ?perf (see src/DuoCard/perf.ts). `npm run perf` builds first, then runs this.
//
//   node scripts/perf.mjs [--runs 5] [--cpu 4] [--url http://localhost:5178/]
//
// --cpu slows the page's main thread by that factor, as a slower phone would. --url measures a
// server that runs already, such as the dev server, in place of a preview of dist.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { preview } from "vite";

const { values: options } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    cpu: { type: "string", default: "1" },
    url: { type: "string" },
    chrome: { type: "string", default: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
});
const RUNS = Number(options.runs);
const CPU = Number(options.cpu);

// The phone is an iPhone's viewport, so the card fills the screen; the desktop shows it on the page.
const DEVICES = [
  { name: "phone", width: 390, height: 844, scale: 3, mobile: true },
  { name: "desktop", width: 1440, height: 900, scale: 2, mobile: false },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A DevTools protocol client over the browser's WebSocket. */
async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
    else call.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { method, resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, close: () => socket.close() };
}

async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), "duo-perf-"));
  const chrome = spawn(
    options.chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-webgpu",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chrome exited:\n${log}`)));
  });
  return {
    endpoint,
    async close() {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await exited;
      await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function measure(browser, url, device) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => browser.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, timeout = 30000) => {
    for (const start = Date.now(); Date.now() - start < timeout; await sleep(100)) if (await evaluate(expression)) return;
    throw new Error(`${device.name}: timed out waiting for ${what}`);
  };

  await page("Emulation.setDeviceMetricsOverride", { width: device.width, height: device.height, deviceScaleFactor: device.scale, mobile: device.mobile });
  await page("Emulation.setCPUThrottlingRate", { rate: CPU });
  const target = new URL(url);
  target.searchParams.set("perf", "");
  await page("Page.navigate", { url: target.href });
  // The links show once the renderer is up; the fallback card has no .duo-canvas.
  await until(`!!document.querySelector(".duo-links a") || (document.readyState === "complete" && !document.querySelector(".duo-canvas"))`, "the card");
  if (!(await evaluate(`!!document.querySelector(".duo-canvas")`))) throw new Error(`${device.name}: no WebGPU, the page shows the fallback card`);
  // A still moment, for the display's period and the contribution graph's redraw.
  await sleep(1500);

  // A point on the card that is not a link, so a click only folds it.
  const spot = `(() => {
    const box = document.querySelector(".duo-viewport").getBoundingClientRect();
    for (const [fx, fy] of [[0.75, 0.5], [0.5, 0.85], [0.25, 0.85], [0.5, 0.6]]) {
      const x = box.left + box.width * fx, y = box.top + box.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest("a, .duo-dock")) return { x, y };
    }
    return null;
  })()`;
  const sessions = [];
  for (let run = 0; run < RUNS * 2; run++) {
    const at = await evaluate(spot);
    if (!at) throw new Error(`${device.name}: no point on the card to click`);
    const count = await evaluate(`window.__duoPerf.sessions.length`);
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    await page("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
    // Off the card, so the name's hover reveal does not hold it.
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await until(`window.__duoPerf.sessions.length > ${count}`, "a session", 10000);
    sessions.push({ kind: run % 2 ? "close" : "open", ...(await evaluate(`window.__duoPerf.sessions.at(-1)`)) });
    await sleep(300);
  }
  // Cost per draw, back to back: the faces, then the whole card.
  await sleep(300);
  const bench = [];
  for (let i = 0; i < 5; i++) bench.push(await evaluate(`window.__duoPerf.bench(30)`));
  await browser.send("Target.closeTarget", { targetId });
  return { sessions, bench };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const ms = (value) => Number(value.toFixed(1));

/** One row per direction: the median over the runs of each figure, and the dropped frames of all. */
function summarize(sessions) {
  return Object.fromEntries(
    ["open", "close"].map((kind) => {
      const runs = sessions.filter((s) => s.kind === kind);
      const m = (pick) => ms(median(runs.map(pick)));
      return [
        kind,
        {
          frames: m((s) => s.frames),
          dropped: runs.reduce((sum, s) => sum + s.dropped, 0),
          "long frames": runs.reduce((sum, s) => sum + s.longFrames, 0),
          "interval p95": m((s) => s.interval.p95),
          "interval max": m((s) => s.interval.max),
          "cpu p50": m((s) => s.cpu.p50),
          "cpu p95": m((s) => s.cpu.p95),
          "faces p95": m((s) => s.faces.p95),
          "gpu p50": m((s) => s.gpu.p50),
          "gpu p95": m((s) => s.gpu.p95),
          "gpu p95 faces": m((s) => s.gpuFaces.p95),
          "gpu p95 still": m((s) => s.gpuStill.p95),
        },
      ];
    }),
  );
}

const server = options.url ? null : await preview({ preview: { port: 4179 }, logLevel: "silent" });
const url = options.url ?? server.resolvedUrls.local[0];
const chrome = await launchChrome();
const browser = await connect(chrome.endpoint);
try {
  for (const device of DEVICES) {
    const { sessions, bench } = await measure(browser, url, device);
    const period = median(sessions.map((s) => s.period));
    console.log(`\n${device.name} ${device.width}×${device.height} @${device.scale}x, cpu ÷${CPU}, ${RUNS} runs, frame ${ms(period)} ms (in ms)`);
    console.table(summarize(sessions));
    console.log(`per draw, back to back: faces ${ms(median(bench.map((b) => b.faces)))} ms, card ${ms(median(bench.map((b) => b.card)))} ms`);
  }
} finally {
  browser.close();
  await chrome.close();
  await server?.close();
}
