import { draw, effect, frame, geometry, init, sampler, surface, target } from "vgpu";
import {
  BODY,
  CLOSED_VIEW,
  FRONT_PAGE,
  FULLSCREEN_INSET,
  INNER_SCREEN,
  buildBody,
  layoutShape,
  spineEdge,
  type Layout,
  type Shape,
} from "./geometry";
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

// In the fullscreen layout: how far the view pulls back halfway through the turn, so the card's
// body shows while it turns.
const PULL_BACK = 0.3;

/** A view of the card's plane: `center` on x draws in the view's middle, `unitsTall` span its height. */
export type Camera = { center: number; unitsTall: number };

/**
 * The fullscreen layout's view: one page at a time. Closed, it shows the front, with the spine along
 * its left edge; open, the home screen. On the way it follows the cover and pulls back a little.
 * Each rest view covers the view's shape (`viewAspect`, width / height), so a view a little off the
 * card's shape crops the page instead of showing past it.
 */
export function fullscreenCamera(shape: Shape, angle: number, viewAspect: number): Camera {
  const height = shape.screenHeight - 2 * FULLSCREEN_INSET;
  const cover = (lo: number, hi: number) => ({ center: (lo + hi) / 2, unitsTall: Math.min(height, (hi - lo) / viewAspect) });
  const closed = cover(CLOSED_VIEW.lo, CLOSED_VIEW.hi);
  const open = cover(INNER_SCREEN.x + FULLSCREEN_INSET, 0);
  const theta = (angle / 180) * Math.PI;
  const t = (1 - Math.cos(theta)) / 2;
  return {
    center: closed.center + (open.center - closed.center) * t,
    unitsTall: (closed.unitsTall + (open.unitsTall - closed.unitsTall) * t) * (1 + PULL_BACK * Math.sin(theta)),
  };
}

/** Where the free edge draws in the fullscreen layout, in view widths from the view's middle. Monotonic in the angle. */
export function fullscreenEdge(shape: Shape, angle: number, viewAspect: number) {
  const view = fullscreenCamera(shape, angle, viewAspect);
  return (projectedEdge(angle) - view.center) / (view.unitsTall * viewAspect);
}

/** The vertical field of view that shows `unitsTall` on the card's plane. */
const fieldOfView = (unitsTall: number) => 2 * Math.atan(unitsTall / 2 / (EYE_Z - BODY.top));

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

export async function createRenderer(canvas: HTMLCanvasElement, shadowCanvas: HTMLCanvasElement, content: CardContent, fonts: Fonts, layout: Layout) {
  if (!("gpu" in navigator)) throw new Error("WebGPU is not available");
  const gpu = await init();
  gpu.onError((error) => console.error("[duo-card]", error));
  const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
  const scene = target(gpu, { size: canvasSurface.size, format: "rgba16float", depth: true, msaa: true });

  const shape = layoutShape(layout);
  const mesh = buildBody(shape);
  const body = draw(gpu, {
    shader: bodyShader(shape),
    geometry: geometry(gpu, {
      buffers: [{ attributes: { position: "float32x3", normal: "float32x3", face: "float32" }, data: mesh.vertices }],
      indices: mesh.indices,
    }),
    cull: "back",
  });

  const maps = await createContent(gpu, content, fonts, shape);
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
  const shadow = effect(gpu, shadowShader(shape));

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

  // The fullscreen layout's view at the current angle; the page layout frames FRAME_UNITS.
  function camera() {
    const [width, height] = canvasSurface.size;
    return layout.kind === "fullscreen" ? fullscreenCamera(shape, angle, width / height) : null;
  }

  function uniforms() {
    const [width, height] = canvasSurface.size;
    const view = camera();
    return {
      viewProjection: view ? perspective(fieldOfView(view.unitsTall), width / height, -view.center) : perspective(fovY, width / height, -viewCenter(angle)),
      eye: [0, 0, EYE_Z],
      foldAngle: ((180 - angle) / 180) * Math.PI,
      innerFrame: [INNER_SCREEN.x, -shape.screenHeight / 2, INNER_SCREEN.width, shape.screenHeight],
      outerFrame: [FRONT_PAGE.x, -shape.screenHeight / 2, FRONT_PAGE.width, shape.screenHeight],
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
    // The shadow canvas frames the card's plane the same way the card's canvas does: on the page
    // larger, in the fullscreen layout the same.
    const view = camera();
    const extentY = view ? view.unitsTall : (FRAME_UNITS.height + 2 * SHADOW_MARGIN) * ((EYE_Z - BODY.top) / EYE_Z);
    const foldAngle = ((180 - angle) / 180) * Math.PI;
    shadow.set({
      shadow: {
        extent: [(extentY * shadowWidth) / shadowHeight, extentY],
        center: view ? view.center : viewCenter(angle),
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
