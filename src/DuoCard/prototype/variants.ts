// PROTOTYPE, throwaway (branch prototype/mobile-fullscreen). The question: on a phone, how does the
// card fill the screen instead of sitting small in the middle of the page? Three fullscreen
// variants of DuoCard on the existing route, switched with ?variant=. No ?variant= is the current,
// centred card.

export type VariantKey = "turn" | "scroll" | "flip";

export const VARIANTS: { key: VariantKey | null; name: string }[] = [
  { key: null, name: "Current: centred card" },
  { key: "turn", name: "Turn: swipe left, the cover turns" },
  { key: "scroll", name: "Scroll: scroll down to open" },
  { key: "flip", name: "Flip: swipe up, hinge across" },
];

const param = new URLSearchParams(location.search).get("variant");
export const VARIANT = (VARIANTS.find((v) => v.key === param)?.key ?? null) as VariantKey | null;

// The viewport's shape when the page loads. The card's geometry and textures are built once from
// it, so a resize or a turn of the phone needs a reload.
const aspect = Math.min(0.75, Math.max(0.4, innerWidth / innerHeight));

// The inner screen's height in model units; its width stays 15.8, two pages of 7.9. Turn and
// scroll give each page the screen's shape. Flip turns the card a quarter, so the open spread of
// two pages, stacked, has the screen's shape.
export const SCREEN_HEIGHT = VARIANT === "flip" ? 15.8 * aspect : VARIANT ? 7.9 / aspect : 11.1;

// Flip draws every page a quarter turned into its texture, so it reads upright on the turned card.
export const TURN_PAGES = VARIANT === "flip";

/**
 * A 2D camera on the card's plane: `center` (model units) draws in the middle of the screen,
 * `unitsTall` model units span the screen's height, and the image turns by `roll` radians.
 */
export type Camera = { center: [number, number]; unitsTall: number; roll: number };

const PAGE = 7.9;

/**
 * The camera for a variant. `angle` is the fold, 0 closed to 180 open. `pan` is the scroll
 * variant's second phase, 0 on the right page to 1 on the left. `viewAspect` is width / height.
 */
export function variantCamera(variant: VariantKey, angle: number, pan: number, viewAspect: number): Camera {
  const theta = (angle / 180) * Math.PI;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  if (variant === "turn") {
    // One page fills the screen. The camera follows the cover from the front to the home screen,
    // and pulls back a little on the way, so the card's body shows while it turns.
    return { center: [(PAGE / 2) * Math.cos(theta), 0], unitsTall: (PAGE / viewAspect) * (1 + 0.3 * Math.sin(theta)), roll: 0 };
  }
  if (variant === "scroll") {
    // First the cover lifts off the right page, then the camera slides to the home screen.
    const x = (PAGE / 2) * (1 - 2 * smooth(pan));
    return { center: [x, 0], unitsTall: (PAGE / viewAspect) * (1 + 0.35 * Math.sin(theta)), roll: 0 };
  }
  // Flip: the hinge runs across the screen, the cover folds up from the bottom half. Closed, the
  // whole card shows, centred; open, the two pages fill the screen.
  const open = (1 - Math.cos(theta)) / 2;
  const closedTall = (SCREEN_HEIGHT + 0.8 + 1.4) / viewAspect;
  return {
    center: [(PAGE / 2 + 0.2) * (1 - open), 0],
    unitsTall: closedTall + (2 * PAGE - closedTall) * open,
    roll: -Math.PI / 2,
  };
}

/** Where a model point on the card's plane draws, in CSS pixels of a `width` × `height` view. */
export function modelToCss(camera: Camera, x: number, y: number, width: number, height: number) {
  const perUnit = height / camera.unitsTall;
  const dx = x - camera.center[0];
  const dy = y - camera.center[1];
  const c = Math.cos(camera.roll);
  const s = Math.sin(camera.roll);
  return { x: width / 2 + (c * dx - s * dy) * perUnit, y: height / 2 - (s * dx + c * dy) * perUnit };
}

/** The scroll variant: how far the page is scrolled, 0 to 1. */
export function scrollProgress() {
  const range = document.documentElement.scrollHeight - innerHeight;
  return range > 0 ? Math.min(1, Math.max(0, scrollY / range)) : 0;
}

// The state the switcher shows, written each frame by DuoCard.
export const prototypeState = { angle: 0, pan: 0 };
