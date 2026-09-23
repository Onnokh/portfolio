import type { Gpu } from "vgpu";
import { texture } from "vgpu";
import { FRONT_PAGE, INNER_SCREEN, type Shape } from "./geometry";
import type { ContributionDay } from "./github";

export type HomeApp = {
  name: string;
  description: string;
  href: string;
  // Square app icon, full-bleed: the home screen masks it. Same-origin or served with CORS, so the
  // canvas it is drawn into stays readable.
  icon: string;
};

export type CardContent = {
  name: string;
  role: string;
  handle: string;
  footnote?: string;
  // The contribution graph widget: where it links, and its days, which arrive after the first draw.
  github: { href: string; days: ContributionDay[] };
  // The home screen's apps: the projects, and the profiles elsewhere.
  apps: HomeApp[];
  // The home screen's wallpaper, blurred as iOS blurs it. Without one the page is plain paper.
  wallpaper?: string;
};

// Texture density, the same as the reference: about 130 texels per model unit.
export const TEXELS_PER_UNIT = 2048 / INNER_SCREEN.width;
// Layout is written in "card pixels": one page is 240 wide, as in the DOM card.
export const CARD_PX = TEXELS_PER_UNIT * (INNER_SCREEN.width / 2 / 240);

const INK = "#0a0a0a";
const MUTED = "#737373";
const PAPER = "#ffffff";
const PAD = 18;
// The name on the front, in card pixels: at rest every line has this cap height, the lines touch,
// and the first bleeds this far off the top. Tracking is in ems.
const NAME = { cap: 102, gap: 0, bleed: 28, tracking: -0.03 } as const;
// At rest, each line starts this share of its own width left of the page, so only fragments show.
const NAME_CROP = [0.03, 0.115, 0.175];
// Room kept for the small print under the name, from the bottom margin up.
const SMALL_PRINT = 34;
// The home screen on the left page, in card pixels: a medium widget with the GitHub contribution
// graph, then, with room above them, the apps, four to a row as on an iPhone. The rows span the
// widget's width, their outer icons on the widget's edges.
const WIDGET = { top: PAD, height: 96, radius: 22, padding: 9, fill: "#0d0d0f", label: 11 } as const;
// How far the wallpaper is blurred, in texels: about a sixteenth of the page's width, as iOS does.
const WALLPAPER_BLUR = 64;
// GitHub's dark-theme shades, from no contributions to the most.
const GRAPH = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];
const APPS = { size: 40, columns: 4, label: 11, gap: 16, above: 30 } as const;

type Rect = { x: number; y: number; width: number; height: number };

// The home screen's images, loaded once: the app icons, and the wallpaper, already blurred.
type HomeAssets = { icons: (HTMLImageElement | null)[]; wallpaper: HTMLCanvasElement | null };

/** Sets up a label on the home screen: white with a soft shadow on a wallpaper, as iOS sets them. */
function labelStyle(ctx: CanvasRenderingContext2D, onWallpaper: boolean) {
  ctx.fillStyle = onWallpaper ? PAPER : INK;
  if (!onWallpaper) return;
  ctx.shadowColor = "rgb(0 0 0 / 0.45)";
  ctx.shadowBlur = 2.5 * CARD_PX;
  ctx.shadowOffsetY = 0.5 * CARD_PX;
}

/**
 * `image` cropped to cover `width` × `height` texels, then blurred by about `radius` texels: scaled
 * down by halves until a pixel spans the radius, then back up by doubles, each step smoothing, so
 * the result is soft without the grid a single large upscale would leave. It works where canvas
 * filters do not, and runs once.
 */
function blurredCover(image: HTMLImageElement, width: number, height: number, radius: number) {
  const make = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  let level = make(width, height);
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sw = width / scale;
  const sh = height / scale;
  level.getContext("2d")!.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, 0, 0, width, height);
  const step = (w: number, h: number) => {
    const next = make(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const ctx = next.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(level, 0, 0, next.width, next.height);
    level = next;
  };
  while (level.width > width / radius) step(level.width / 2, level.height / 2);
  while (level.width < width) step(Math.min(width, level.width * 2), Math.min(height, level.height * 2));
  // A light dim, as the home screen gives its wallpaper, so white labels hold.
  const ctx = level.getContext("2d")!;
  ctx.fillStyle = "rgb(0 0 0 / 0.08)";
  ctx.fillRect(0, 0, width, height);
  return level;
}

// A link over the page, in texels, with the corner radius of what it covers.
export type LinkRect = Rect & { href: string; label: string; radius: number };

export type Fonts = { sans: string; mono: string; display: string };

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function font(weight: number, size: number, family: string) {
  return `${weight} ${size * CARD_PX}px ${family}`;
}

/** Draws one page. `x` is the left edge of the page in texels; everything else is in card pixels. */
function page(ctx: CanvasRenderingContext2D, x: number) {
  const px = (v: number) => x + v * CARD_PX;
  const py = (v: number) => v * CARD_PX;
  return { px, py };
}

/**
 * A rectangle with continuous corners, as iOS draws icons and widgets: each corner a quarter of a
 * superellipse, so the curve eases out of the straight edge instead of meeting it at a tangent
 * break. With `r` at half the side, a square becomes a full squircle. In texels.
 */
function smoothRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const N = 5;
  const STEPS = 24;
  const corners: [number, number, number][] = [
    [x + w - r, y + r, 0],
    [x + w - r, y + h - r, 90],
    [x + r, y + h - r, 180],
    [x + r, y + r, 270],
  ];
  ctx.beginPath();
  corners.forEach(([cx, cy, start], corner) => {
    for (let i = 0; i <= STEPS; i++) {
      const t = ((start - 90 + (i / STEPS) * 90) * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const px = cx + r * Math.sign(c) * Math.abs(c) ** (2 / N);
      const py = cy + r * Math.sign(s) * Math.abs(s) ** (2 / N);
      if (corner === 0 && i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  });
  ctx.closePath();
}

/**
 * The glass rim iOS gives icons and widgets: a light edge just inside the shape, brightest at the
 * top left, fading round, and catching the light again at the bottom right, over a faint sheen on
 * the top half. In texels; `rim` is the stroke width, half of which shows inside the shape.
 */
function glassRim(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, rim: number, strength = 1) {
  const white = (alpha: number) => `rgb(255 255 255 / ${alpha * strength})`;
  ctx.save();
  smoothRect(ctx, x, y, w, h, r);
  ctx.clip();
  const sheen = ctx.createLinearGradient(0, y, 0, y + h * 0.55);
  sheen.addColorStop(0, white(0.14));
  sheen.addColorStop(1, white(0));
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h * 0.55);
  const edge = ctx.createLinearGradient(x, y, x + w, y + h);
  edge.addColorStop(0, white(0.85));
  edge.addColorStop(0.3, white(0.18));
  edge.addColorStop(0.7, white(0.08));
  edge.addColorStop(1, white(0.5));
  ctx.strokeStyle = edge;
  ctx.lineWidth = rim;
  smoothRect(ctx, x, y, w, h, r);
  ctx.stroke();
  ctx.restore();
}

/**
 * The status in the top right corner of the open card, as on the reference's cover: the time, and
 * under it a wifi gauge, a ring that runs solid over the top and dotted along the bottom. In the
 * page's own coordinates, white, for the black right page.
 */
function drawStatus(ctx: CanvasRenderingContext2D, px: (v: number) => number, py: (v: number) => number, width: number, fonts: Fonts) {
  const r = 8;
  const cx = width - PAD - r;
  const cy = PAD + 22;
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.strokeStyle = PAPER;
  ctx.font = font(600, 8.5, fonts.sans);
  ctx.letterSpacing = "0px";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("9:41", px(cx), py(PAD + 8));

  const deg = Math.PI / 180;
  ctx.lineWidth = 1.3 * CARD_PX;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(px(cx), py(cy), r * CARD_PX, 135 * deg, 45 * deg);
  ctx.stroke();
  for (const angle of [63, 81, 99, 117]) {
    ctx.beginPath();
    ctx.arc(px(cx + r * Math.cos(angle * deg)), py(cy + r * Math.sin(angle * deg)), 0.75 * CARD_PX, 0, Math.PI * 2);
    ctx.fill();
  }
  // The wifi mark: three arcs over a dot.
  ctx.lineWidth = 1 * CARD_PX;
  for (const radius of [1.3, 2.9, 4.5]) {
    ctx.beginPath();
    ctx.arc(px(cx), py(cy + 2.6), radius * CARD_PX, -135 * deg, -45 * deg);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(px(cx), py(cy + 2.6), 0.6 * CARD_PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A day as "YYYY-MM-DD", counted in UTC so no time zone shifts it. */
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const DAY = 86400000;

/**
 * The contribution graph as a medium widget: as many weeks as fit, oldest on the left, Sunday at
 * the top as GitHub lays them out, the current week cut off at the last day. Until the days arrive
 * every square is empty. The widget's name sits under it, and the whole widget is the link. Returns
 * its bottom, in card pixels, and its box, in texels.
 */
function drawGraph(ctx: CanvasRenderingContext2D, left: number, width: number, content: CardContent, fonts: Fonts, onWallpaper: boolean) {
  const { px, py } = page(ctx, left);
  const { top, height, radius, padding, fill, label } = WIDGET;
  const x0 = PAD;
  const w = width - PAD * 2;
  ctx.save();
  ctx.fillStyle = fill;
  smoothRect(ctx, px(x0), py(top), w * CARD_PX, height * CARD_PX, radius * CARD_PX);
  ctx.fill();

  // Seven rows fill the height; the width takes as many whole weeks as fit, centred.
  const pitch = (height - padding * 2) / 7;
  const cell = pitch * 0.8;
  const weeks = Math.floor((w - padding * 2 + pitch - cell) / pitch);
  const gx = x0 + (w - (weeks * pitch - (pitch - cell))) / 2;
  const gy = top + (height - (7 * pitch - (pitch - cell))) / 2;
  const { days } = content.github;
  const levels = new Map(days.map((day) => [day.date, day.level]));
  const [y, m, d] = (days.at(-1)?.date ?? new Date().toLocaleDateString("sv")).split("-").map(Number);
  const last = Date.UTC(y, m - 1, d);
  const firstSunday = last - new Date(last).getUTCDay() * DAY - (weeks - 1) * 7 * DAY;
  // The widget's corners round off the corner squares, as iOS masks widget content.
  const inset = 4;
  smoothRect(ctx, px(x0 + inset), py(top + inset), (w - inset * 2) * CARD_PX, (height - inset * 2) * CARD_PX, (radius - inset) * CARD_PX);
  ctx.clip();
  for (let week = 0; week < weeks; week++) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const time = firstSunday + (week * 7 + weekday) * DAY;
      if (time > last) break;
      ctx.fillStyle = GRAPH[levels.get(isoDay(time)) ?? 0];
      ctx.beginPath();
      ctx.roundRect(px(gx + week * pitch), py(gy + weekday * pitch), cell * CARD_PX, cell * CARD_PX, cell * 0.24 * CARD_PX);
      ctx.fill();
    }
  }
  ctx.restore();
  glassRim(ctx, px(x0), py(top), w * CARD_PX, height * CARD_PX, radius * CARD_PX, 1.6 * CARD_PX, 0.45);

  ctx.save();
  ctx.font = font(500, 7, fonts.sans);
  labelStyle(ctx, onWallpaper);
  ctx.textAlign = "center";
  ctx.fillText("GitHub", px(x0 + w / 2), py(top + height + label));
  ctx.restore();
  const link: LinkRect = {
    href: content.github.href,
    label: "GitHub contributions",
    x: px(x0),
    y: py(top),
    width: w * CARD_PX,
    height: height * CARD_PX,
    radius: radius * 0.62 * CARD_PX,
  };
  return { bottom: top + height + label + 3, links: [link] };
}

/** `text` cut to `width` texels at the current font, with an ellipsis, the way iOS cuts app names. */
function fitText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * The apps under the widget, four to a row: each icon a squircle with a glass rim and a soft
 * shadow, its name under it. Returns a box per icon, in texels.
 */
function drawApps(ctx: CanvasRenderingContext2D, left: number, width: number, top: number, content: CardContent, fonts: Fonts, { icons, wallpaper }: HomeAssets) {
  const { px, py } = page(ctx, left);
  const { size, columns, label, gap } = APPS;
  const spacing = (width - PAD * 2 - columns * size) / (columns - 1);
  const links: LinkRect[] = [];
  ctx.save();
  content.apps.forEach((app, i) => {
    const x = PAD + (i % columns) * (size + spacing);
    const y = top + Math.floor(i / columns) * (size + label + gap);
    ctx.save();
    ctx.shadowColor = "rgb(0 0 0 / 0.16)";
    ctx.shadowBlur = 6 * CARD_PX;
    ctx.shadowOffsetY = 2 * CARD_PX;
    ctx.fillStyle = "#d9d9dc";
    smoothRect(ctx, px(x), py(y), size * CARD_PX, size * CARD_PX, (size / 2) * CARD_PX);
    ctx.fill();
    ctx.restore();
    const icon = icons[i];
    if (icon) {
      ctx.save();
      smoothRect(ctx, px(x), py(y), size * CARD_PX, size * CARD_PX, (size / 2) * CARD_PX);
      ctx.clip();
      ctx.drawImage(icon, px(x), py(y), size * CARD_PX, size * CARD_PX);
      ctx.restore();
    }
    glassRim(ctx, px(x), py(y), size * CARD_PX, size * CARD_PX, (size / 2) * CARD_PX, 2.2 * CARD_PX);
    ctx.save();
    ctx.font = font(500, 7, fonts.sans);
    labelStyle(ctx, wallpaper !== null);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitText(ctx, app.name, (size + spacing - 3) * CARD_PX), px(x + size / 2), py(y + size + label));
    ctx.restore();
    links.push({
      href: app.href,
      label: `${app.name}. ${app.description}`,
      x: px(x),
      y: py(y),
      width: size * CARD_PX,
      height: size * CARD_PX,
      radius: size * 0.225 * CARD_PX,
    });
  });
  ctx.restore();
  return links;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The front: the name knocked out of a black page, one word per line, far past the page's size, so
 * at rest only fragments show. `reveal`, 0 to 1, moves each line into a readable place, justified
 * to the margins and a little after the line above it; the card reveals the name while the mouse
 * rests on it and while the card is open. The inside right page repeats the front in the same box,
 * so the front lies exactly on its copy; with `status` that copy also has the corner status.
 */
function drawFront(
  ctx: CanvasRenderingContext2D,
  left: number,
  width: number,
  height: number,
  margin: number,
  content: CardContent,
  fonts: Fonts,
  reveal: number,
  status = false,
) {
  const { px, py } = page(ctx, left);
  const setSize = (size: number) => {
    ctx.font = font(400, size, fonts.display);
    ctx.letterSpacing = `${NAME.tracking * size * CARD_PX}px`;
  };
  const words = content.name.toUpperCase().split(/\s+/);

  ctx.save();
  ctx.beginPath();
  ctx.rect(px(0), py(0), width * CARD_PX, height * CARD_PX);
  ctx.clip();
  ctx.fillStyle = INK;
  ctx.fillRect(px(0), py(0), width * CARD_PX, height * CARD_PX);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Measure at 100 card pixels; per card pixel of size, the cap height and each word's ink width.
  setSize(100);
  const cap = ctx.measureText("H").actualBoundingBoxAscent / CARD_PX / 100;
  const inks = words.map((word) => {
    const m = ctx.measureText(word);
    return { left: m.actualBoundingBoxLeft / CARD_PX / 100, width: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / CARD_PX / 100 };
  });

  // At rest: one size, each word shifted left by its share of its own width.
  const restSize = NAME.cap / cap;
  const rest = inks.map((ink, i) => ({
    size: restSize,
    x: -NAME_CROP[i % NAME_CROP.length] * ink.width * restSize,
    baseline: NAME.cap - NAME.bleed + i * (NAME.cap + NAME.gap),
  }));
  // Revealed: each word justified to the margins, the block centred above the small print.
  const GAP = 8;
  const sizes = inks.map((ink) => (width - margin - PAD) / ink.width);
  const block = sizes.reduce((sum, size) => sum + size * cap, 0) + GAP * (words.length - 1);
  let y = PAD + (height - PAD * 2 - SMALL_PRINT - block) / 2;
  const revealed = sizes.map((size) => {
    y += size * cap;
    const baseline = y;
    y += GAP;
    return { size, x: margin, baseline };
  });

  // Each line eases on its own, a little after the one above it; sizes ease on a log scale.
  const STAGGER = 0.12;
  const span = 1 - STAGGER * (words.length - 1);
  ctx.fillStyle = PAPER;
  words.forEach((word, i) => {
    const t = easeInOutCubic(Math.min(1, Math.max(0, (reveal - i * STAGGER) / span)));
    const from = rest[i];
    const to = revealed[i];
    const size = from.size * (to.size / from.size) ** t;
    setSize(size);
    ctx.fillText(word, px(from.x + (to.x - from.x) * t + inks[i].left * size), py(from.baseline + (to.baseline - from.baseline) * t));
  });

  // The small print along the bottom.
  ctx.font = font(500, 6, fonts.mono);
  ctx.letterSpacing = `${0.08 * 6 * CARD_PX}px`;
  ctx.fillStyle = PAPER;
  ctx.fillText([content.role, content.footnote ?? ""].filter(Boolean).join(" - ").toUpperCase(), px(margin), py(height - PAD - 9));
  ctx.fillStyle = "#8a8a86";
  ctx.fillText(content.handle.toUpperCase(), px(margin), py(height - PAD));
  if (status) drawStatus(ctx, px, py, width, fonts);
  ctx.restore();
}

/** The inner image's size in texels: both pages, `height` tall. */
const innerSize = (shape: Shape) => [Math.round(INNER_SCREEN.width * TEXELS_PER_UNIT), Math.round(shape.screenHeight * TEXELS_PER_UNIT)] as const;

function drawInner(
  content: CardContent,
  fonts: Fonts,
  assets: HomeAssets,
  [width, height]: readonly [number, number],
  frontMargin: number,
  reveal = 0,
  into?: HTMLCanvasElement,
) {
  const canvas = into ?? Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d")!;
  // The left half is the home screen's wallpaper; the right half is black up to the fold, so the
  // open spread divides at the hinge, and the strip beside the front shows black as it lifts.
  if (assets.wallpaper) ctx.drawImage(assets.wallpaper, 0, 0);
  else {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, width / 2, height);
  }
  ctx.fillStyle = INK;
  ctx.fillRect(width / 2, 0, width / 2, height);

  const pageHeight = height / CARD_PX;

  // Left page, the inside of the cover: a home screen, with the contribution graph as a widget and
  // the apps under it.
  const pageWidth = width / 2 / CARD_PX;
  const widget = drawGraph(ctx, 0, pageWidth, content, fonts, assets.wallpaper !== null);
  const apps = drawApps(ctx, 0, pageWidth, widget.bottom + APPS.above, content, fonts, assets);

  // Right page: the fixed half. It repeats the front in the front's box, so what the front shows
  // lies exactly on what is under it.
  const rightX = (FRONT_PAGE.x - INNER_SCREEN.x) * TEXELS_PER_UNIT;
  const rightWidth = (FRONT_PAGE.width * TEXELS_PER_UNIT) / CARD_PX;
  // The inside copy also carries the status in its corner, so it shows only once the card opens.
  drawFront(ctx, rightX, rightWidth, pageHeight, frontMargin, content, fonts, reveal, true);
  // The name on the right page, above the small print, in texels: the area that reveals it on hover.
  const nameArea = { x: rightX, y: 0, width: rightWidth * CARD_PX, height: (pageHeight - PAD - SMALL_PRINT) * CARD_PX };

  return { canvas, links: [...widget.links, ...apps], nameArea };
}

function drawOuter(content: CardContent, fonts: Fonts, height: number, frontMargin: number, reveal = 0, into?: HTMLCanvasElement) {
  const width = Math.round(FRONT_PAGE.width * TEXELS_PER_UNIT);
  const canvas = into ?? Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  drawFront(ctx, 0, width / CARD_PX, height / CARD_PX, frontMargin, content, fonts, reveal);
  return canvas;
}

/**
 * A texture with a full mip chain that a canvas can be written into, again and again: each level a
 * half-size redraw of the one above, on scratch canvases kept between writes.
 */
function mipTexture(gpu: Gpu, width: number, height: number, label: string) {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const tex = texture(gpu, {
    kind: "2d",
    size: [width, height],
    format: "rgba8unorm-srgb",
    usage: ["texture_binding", "copy_dst", "render_attachment"],
    mipLevelCount: levels,
    label,
  });
  const scratch: HTMLCanvasElement[] = [];
  const write = (source: HTMLCanvasElement) => {
    let level = source;
    for (let i = 0; i < levels; i++) {
      if (i > 0) {
        const next = (scratch[i] ??= Object.assign(document.createElement("canvas"), {
          width: Math.max(1, level.width >> 1),
          height: Math.max(1, level.height >> 1),
        }));
        const ctx = next.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(level, 0, 0, next.width, next.height);
        level = next;
      }
      gpu.gpu.queue.copyExternalImageToTexture({ source: level, flipY: false }, { texture: tex.gpu, mipLevel: i }, [level.width, level.height]);
    }
  };
  return { tex, write };
}

export async function createContent(gpu: Gpu, content: CardContent, fonts: Fonts, shape: Shape) {
  await document.fonts?.ready;
  // Canvas text does not make the browser fetch a web font, so load the faces it uses first.
  await Promise.all([
    document.fonts?.load(`400 100px ${fonts.display}`, content.name.toUpperCase()),
    document.fonts?.load(`400 12px ${fonts.sans}`),
    document.fonts?.load(`600 12px ${fonts.sans}`),
  ]);
  const [icons, wallpaper] = await Promise.all([
    Promise.all(content.apps.map((app) => loadImage(app.icon))),
    content.wallpaper ? loadImage(content.wallpaper) : null,
  ]);
  const size = innerSize(shape);
  const [width, height] = size;
  const assets: HomeAssets = { icons, wallpaper: wallpaper && blurredCover(wallpaper, width / 2, height, WALLPAPER_BLUR) };
  // The front's left margin, in card pixels: the page margin, less the band that shows beside it.
  const frontMargin = PAD - (shape.frontBand * TEXELS_PER_UNIT) / CARD_PX;
  const inner = drawInner(content, fonts, assets, size, frontMargin);
  const outer = drawOuter(content, fonts, height, frontMargin);
  const innerMips = mipTexture(gpu, inner.canvas.width, inner.canvas.height, "card:inner");
  const outerMips = mipTexture(gpu, outer.width, outer.height, "card:outer");
  innerMips.write(inner.canvas);
  outerMips.write(outer);
  let innerReveal = 0;
  const redrawInner = () => innerMips.write(drawInner(content, fonts, assets, size, frontMargin, innerReveal, inner.canvas).canvas);
  return {
    inner: innerMips.tex,
    outer: outerMips.tex,
    // Redraws one face with the name revealed by `t`, 0 to 1, and uploads it again.
    reveal(face: "inner" | "outer", t: number) {
      if (face === "inner") {
        innerReveal = t;
        redrawInner();
      } else outerMips.write(drawOuter(content, fonts, height, frontMargin, t, outer));
    },
    // Takes the contribution graph's days once they arrive, and redraws the page they are on.
    contributions(days: ContributionDay[]) {
      content.github.days = days;
      redrawInner();
    },
    nameArea: inner.nameArea,
    innerSize: [inner.canvas.width, inner.canvas.height] as const,
    outerSize: [outer.width, outer.height] as const,
    // Link boxes in texels of the inner image, for the clickable overlay.
    links: inner.links,
  };
}
