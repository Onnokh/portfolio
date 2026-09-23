import { draw, effect, frame, geometry, init, sampler, surface, target } from "vgpu";
import { BODY, FRONT_PAGE, INNER_SCREEN, buildBody } from "./geometry";
import { createContent, type CardContent, type Fonts } from "./content";
import type { ContributionDay } from "./github";
import { bodyShader, presentShader, shadowShader } from "./shaders";

// Camera from the reference: a fixed eye 40 units in front of the card, which is also the eye the
// screen content is projected from.
export const EYE_Z = 40;
// Model units the canvas frames. The cover never draws wider than the flat card (see the vertex
// shader), but at 90° its free edge draws ~26% taller, so the frame leaves room above and below.
export const FRAME_UNITS = { width: 17.6, height: 15.4 } as const;
// The shadow falls wider than that frame, so it draws on a canvas of its own, behind the card and
// this many model units larger on every side.
export const SHADOW_MARGIN = 3.5;

/**
 * Where the cover's free edge draws, in model units on the card's plane: -halfWidth open, +halfWidth
 * closed. The cover gets no sideways perspective (see the vertex shader), so this is plain
 * foreshortening and monotonic in the angle.
 */
export function projectedEdge(angle: number) {
  return BODY.halfWidth * Math.cos((angle / 180) * Math.PI);
}

/**
 * The middle of what the card covers at `angle`, in model units: the fixed half runs from the hinge
 * to +halfWidth, and the cover adds its reach once its free edge passes the hinge. The view pans
 * by this, so the card stays centred as it opens. A soft minimum rounds the corner where the edge
 * crosses the hinge, so the pan starts gently rather than at full speed.
 */
export function viewCenter(angle: number) {
  const edge = projectedEdge(angle);
  const SOFT = 1.5;
  const reach = (edge - Math.sqrt(edge * edge + SOFT * SOFT)) / 2;
  return (reach + BODY.halfWidth) / 2;
}

/** Where the free edge draws after that pan, in model units. Monotonic in the angle too. */
export function screenEdge(angle: number) {
  return projectedEdge(angle) - viewCenter(angle);
}

/**
 * The leftmost point of the bent strip over the page, in model units, for a fold angle in radians
 * (0 open, π closed). Open, the strip lies flat and reaches past the hinge; closed, it curls round
 * and the spine sits right of it. This is the Hermite curve of the vertex shader, for both faces.
 */
function spineEdge(foldAngle: number) {
  const c = Math.cos(foldAngle);
  const s = Math.sin(foldAngle);
  const h = BODY.hingeHalfWidth;
  let edge = Infinity;
  for (const z of [BODY.top, BODY.bottom]) {
    const start = -h * c + s * (z - BODY.hingeZ);
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      const x =
        (2 * t ** 3 - 3 * t ** 2 + 1) * start +
        (t ** 3 - 2 * t ** 2 + t) * 2 * h * c +
        (-2 * t ** 3 + 3 * t ** 2) * h +
        (t ** 3 - t ** 2) * 2 * h;
      edge = Math.min(edge, x);
    }
  }
  return edge;
}

const NEAR = 0.1;
const FAR = 250;
// Reference blur: 72 texels of a 1600-texel image across the 15.8-unit inner screen.
const BLUR_UNITS = (72 / 1600) * 15.8;

/** `pan` shifts the whole image sideways, in model units at the card's plane. */
function perspective(fovY: number, aspect: number, pan: number) {
  const f = 1 / Math.tan(fovY / 2);
  const range = 1 / (NEAR - FAR);
  // Column-major, WebGPU clip depth 0..1, camera looking down -z from (0, 0, EYE_Z).
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = FAR * range;
  m[11] = -1;
  m[14] = NEAR * FAR * range;
  // Fold the view translation (0, 0, -EYE_Z) in: column 3 += column 2 * -EYE_Z.
  m[14] += m[10] * -EYE_Z;
  m[15] = m[11] * -EYE_Z;
  // A pan in clip space: row 0 += dx * row 3, so every depth moves by the same screen distance.
  const dx = (pan * m[0]) / (EYE_Z - BODY.top);
  m[8] += dx * m[11];
  m[12] += dx * m[15];
  return m;
}

export type Renderer = Awaited<ReturnType<typeof createRenderer>>;

export async function createRenderer(canvas: HTMLCanvasElement, shadowCanvas: HTMLCanvasElement, content: CardContent, fonts: Fonts) {
  if (!("gpu" in navigator)) throw new Error("WebGPU is not available");
  const gpu = await init();
  gpu.onError((error) => console.error("[duo-card]", error));
  const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
  const scene = target(gpu, { size: canvasSurface.size, format: "rgba16float", depth: true, msaa: true });

  const mesh = buildBody();
  const body = draw(gpu, {
    shader: bodyShader,
    geometry: geometry(gpu, {
      buffers: [{ attributes: { position: "float32x3", normal: "float32x3", face: "float32" }, data: mesh.vertices }],
      indices: mesh.indices,
    }),
    cull: "back",
  });

  const maps = await createContent(gpu, content, fonts);
  body.set({
    innerMap: maps.inner,
    outerMap: maps.outer,
    mapSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
  });

  const present = effect(gpu, presentShader, {
    set: { sceneColor: scene, sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
  });
  // Full resolution: where the card lies on the page, its shadow has a crisp edge.
  const shadowSurface = surface(gpu, shadowCanvas, { dpr: [1, 2] });
  const shadow = effect(gpu, shadowShader);

  const fovY = 2 * Math.atan(FRAME_UNITS.height / 2 / EYE_Z);
  let angle = 180;
  // The name's reveal, and the value each face was last drawn with.
  let reveal = 0;
  const drawn = { inner: 0, outer: 0 };

  // Redraws a face only while it is in view: the front unless the card lies open, the inside
  // unless it lies closed. A face out of view catches up when it comes back.
  function syncReveal() {
    if (angle < 180 && drawn.outer !== reveal) {
      maps.reveal("outer", reveal);
      drawn.outer = reveal;
    }
    if (angle > 0 && drawn.inner !== reveal) {
      maps.reveal("inner", reveal);
      drawn.inner = reveal;
    }
  }

  function uniforms() {
    const [width, height] = canvasSurface.size;
    return {
      viewProjection: perspective(fovY, width / height, -viewCenter(angle)),
      eye: [0, 0, EYE_Z],
      foldAngle: ((180 - angle) / 180) * Math.PI,
      innerFrame: [INNER_SCREEN.x, INNER_SCREEN.y, INNER_SCREEN.width, INNER_SCREEN.height],
      outerFrame: [FRONT_PAGE.x, INNER_SCREEN.y, FRONT_PAGE.width, INNER_SCREEN.height],
      innerPixel: [1 / maps.innerSize[0], 1 / maps.innerSize[1]],
      outerPixel: [1 / maps.outerSize[0], 1 / maps.outerSize[1]],
      innerBlur: BLUR_UNITS * (maps.innerSize[0] / INNER_SCREEN.width),
      outerBlur: BLUR_UNITS * (maps.outerSize[0] / FRONT_PAGE.width),
      // The outer screen turns off once the card lies fully open.
      outerOn: angle >= 180 ? 0 : 1,
      exposure: 1.18,
    };
  }

  canvasSurface.onResize(({ width, height }) => {
    scene.resize([width, height]);
  });

  /** `nameReveal` is how far the name on the front is revealed, 0 to 1. */
  function render(next: number, nameReveal = 0) {
    angle = next;
    reveal = nameReveal;
    syncReveal();
    body.set({ scene: uniforms() });
    const [shadowWidth, shadowHeight] = shadowSurface.size;
    // The shadow canvas frames the card's plane the same way the card's canvas does, only larger.
    const extentY = (FRAME_UNITS.height + 2 * SHADOW_MARGIN) * ((EYE_Z - BODY.top) / EYE_Z);
    const foldAngle = ((180 - angle) / 180) * Math.PI;
    shadow.set({
      shadow: {
        extent: [(extentY * shadowWidth) / shadowHeight, extentY],
        center: viewCenter(angle),
        foldAngle,
        spine: spineEdge(foldAngle),
      },
    });
    frame(gpu, (f) => {
      f.pass({ target: scene, clear: [0, 0, 0, 0], clearDepth: 1 }, (pass) => pass.draw(body));
      f.pass(canvasSurface, present);
      f.pass(shadowSurface, shadow);
    });
  }

  return {
    render,
    // New days for the contribution graph: the inside is redrawn; render again to show it.
    contributions: (days: ContributionDay[]) => maps.contributions(days),
    links: maps.links,
    nameArea: maps.nameArea,
    innerSize: maps.innerSize,
    dispose: () => gpu.dispose(),
  };
}
