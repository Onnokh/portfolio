/**
 * Frame timing for the card, on with `?perf` or `?debug=true` in the URL. Every run of frames that
 * draw, such as one open or close, is one session. At its end the session's summary goes to the
 * console, to a small panel in the top left corner, and to `window.__duoPerf.sessions`, so a script
 * can read it too.
 *
 * - `interval`: time between animation frames. A frame the display had to show twice counts as
 *   dropped; the display's period is the middle interval while the card is still.
 * - `cpu`: time in the frame's JavaScript, and `faces` the part of it that draws and uploads the
 *   card's faces.
 * - `gpu`: time from the frame's submit until the GPU reports it done. The report comes back later
 *   than the work ends, so this is an upper bound. `gpuFaces` is the same for the frames that drew
 *   a face again, `gpuStill` for the frames that did not.
 * - `longFrames`: the browser's own long animation frames (Chromium only).
 *
 * The same spans also show in the DevTools Performance panel, as `duo:frame` and `duo:faces`.
 *
 * `window.__duoPerf.bench(n)` measures cost rather than frames: it draws the faces, then the card,
 * `n` times back to back and gives the milliseconds per draw once the GPU is done. This is the
 * steadiest figure, and the one to compare between two versions of the card.
 */

type Sample = { interval: number; cpu: number; faces: number; redrew: boolean; gpu: number | null };

export type PerfSummary = {
  frames: number;
  duration: number;
  period: number;
  dropped: number;
  longFrames: number;
  interval: Stats;
  cpu: Stats;
  faces: Stats;
  gpu: Stats;
  gpuFaces: Stats;
  gpuStill: Stats;
};

type Stats = { p50: number; p95: number; max: number };

export type Meter = {
  /** Runs and times one animation frame's JavaScript. `fn` returns true if the frame drew. */
  frame(now: number, fn: () => boolean): void;
  /** Times `fn` as the part of the frame that draws the faces. `fn` returns true if it drew one. */
  faces(fn: () => boolean): void;
  /** After the frame's submit: `done` settles when the GPU finishes it. */
  submitted(done: Promise<unknown>): void;
  /** Makes `window.__duoPerf.bench` run `bench`. */
  benchmark(bench: (n: number) => Promise<{ faces: number; card: number }>): void;
  dispose(): void;
};

declare global {
  interface Window {
    __duoPerf?: { sessions: PerfSummary[]; bench?: (n?: number) => Promise<{ faces: number; card: number }> };
  }
}

export const perfEnabled = () => {
  if (typeof location === "undefined") return false;
  const params = new URLSearchParams(location.search);
  return params.has("perf") || params.get("debug") === "true";
};

// Frames without a draw that end a session, so the one still frame between two draws does not split it.
const END_AFTER = 4;
// Shorter sessions are noise, such as a drag of one frame.
const MIN_FRAMES = 8;

function stats(values: number[]): Stats {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const ms = (value: number) => value.toFixed(1).padStart(5);
const gpu = (samples: Sample[]) => stats(samples.flatMap((s) => (s.gpu === null ? [] : [s.gpu])));

export function createMeter(): Meter {
  const sessions = (window.__duoPerf ??= { sessions: [] }).sessions;
  const panel = document.createElement("pre");
  Object.assign(panel.style, {
    position: "fixed",
    top: "8px",
    left: "8px",
    zIndex: "10",
    margin: "0",
    padding: "8px 10px",
    font: "11px/1.4 ui-monospace, monospace",
    color: "#fff",
    background: "rgb(0 0 0 / 0.72)",
    borderRadius: "6px",
    pointerEvents: "none",
    whiteSpace: "pre",
  });
  panel.textContent = "duo perf: open or close the card";
  document.body.append(panel);

  // Intervals while the card is still, for the display's period.
  const still: number[] = [];
  let last = 0;
  let quiet = 0;
  let session: { start: number; samples: Sample[]; longFrames: number } | null = null;
  let current: Sample | null = null;

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      if (session) session.longFrames += list.getEntries().length;
    });
    observer.observe({ type: "long-animation-frame" });
  } catch {
    observer = null;
  }

  function end() {
    const done = session;
    session = null;
    if (!done || done.samples.length < MIN_FRAMES) return;
    // Wait a moment for the last frames' GPU times to land.
    setTimeout(() => report(done), 250);
  }

  function report({ start, samples, longFrames }: NonNullable<typeof session>) {
    const period = still.length >= 10 ? stats(still).p50 : Math.min(...samples.map((s) => s.interval));
    const intervals = samples.map((s) => s.interval);
    const summary: PerfSummary = {
      frames: samples.length,
      duration: performance.now() - start,
      period,
      dropped: intervals.reduce((sum, interval) => sum + Math.max(0, Math.round(interval / period) - 1), 0),
      longFrames,
      interval: stats(intervals),
      cpu: stats(samples.map((s) => s.cpu)),
      faces: stats(samples.map((s) => s.faces)),
      gpu: gpu(samples),
      gpuFaces: gpu(samples.filter((s) => s.redrew)),
      gpuStill: gpu(samples.filter((s) => !s.redrew)),
    };
    sessions.push(summary);
    const row = (name: string, s: Stats) => `${name.padEnd(9)}${ms(s.p50)}${ms(s.p95)}${ms(s.max)}`;
    panel.textContent = [
      `frames ${summary.frames}  dropped ${summary.dropped}  long ${summary.longFrames}`,
      `period ${summary.period.toFixed(1)} ms`,
      `ms         p50  p95  max`,
      row("interval", summary.interval),
      row("cpu", summary.cpu),
      row("faces", summary.faces),
      row("gpu", summary.gpu),
      row(" faces", summary.gpuFaces),
      row(" still", summary.gpuStill),
    ].join("\n");
    console.info("[duo-card] perf", summary);
  }

  return {
    frame(now, fn) {
      // A frame's interval runs until the next frame starts: how long it took to show.
      if (current) current.interval = now - last;
      else if (last && !session) {
        still.push(now - last);
        if (still.length > 120) still.shift();
      }
      last = now;
      current = { interval: 0, cpu: 0, faces: 0, redrew: false, gpu: null };
      const t = performance.now();
      const drew = fn();
      current.cpu = performance.now() - t;
      if (!drew) {
        current = null;
        if (session && ++quiet >= END_AFTER) end();
        return;
      }
      performance.measure("duo:frame", { start: t });
      quiet = 0;
      session ??= { start: now, samples: [], longFrames: 0 };
      session.samples.push(current);
    },
    faces(fn) {
      const t = performance.now();
      if (!fn()) return;
      if (current) {
        current.faces += performance.now() - t;
        current.redrew = true;
      }
      performance.measure("duo:faces", { start: t });
    },
    submitted(done) {
      const sample = current;
      if (!sample) return;
      const t = performance.now();
      done.then(() => (sample.gpu = performance.now() - t));
    },
    benchmark(bench) {
      window.__duoPerf!.bench = (n = 30) => bench(n);
    },
    dispose() {
      delete window.__duoPerf?.bench;
      observer?.disconnect();
      panel.remove();
    },
  };
}
