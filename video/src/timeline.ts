/**
 * What happens in the video, in seconds, and the card's motion that follows from it. The motion is
 * the site's own (see step() in src/DuoCard/DuoCard.tsx): a click eases the fold over TRANSITION
 * seconds for a half turn, and the name moves into its place over REVEAL seconds while the mouse
 * rests on it, while the card opens, and while the card is not closed. A card that opens from
 * closed waits for the name first.
 */

const REVEAL = 0.9;
const TRANSITION = 1.4;

export const SCRIPT = {
  // The cursor comes in, and rests on the name, which moves into its place.
  arrive: 1.4,
  // The click that opens the card, on release.
  open: 2.6,
  // The cursor moves off the name, on the open card.
  leave: 2.9,
  // The click that closes the card. After it the cursor goes, and the name moves back.
  close: 6.6,
  // As it started: closed, the name back, no cursor. So the video loops.
  end: 9.6,
} as const;

// How long a press holds before its release.
export const PRESS = 0.12;

export type CardState = { angle: number; reveal: number };

type Transition = { from: number; to: number; elapsed: number; duration: number };

/** The card at `frame`: steps the site's motion frame by frame from the start, so every frame is the same wherever it renders. */
export function cardAt(frame: number, fps: number): CardState {
  const dt = 1 / fps;
  let angle = 0;
  let reveal = 0;
  let motion: Transition | null = null;
  const clicks: [number, number][] = [
    [SCRIPT.open, 180],
    [SCRIPT.close, 0],
  ];

  for (let i = 1; i <= frame; i++) {
    const now = i * dt;
    for (const [at, to] of clicks) {
      if (at <= now - dt || at > now) continue;
      const duration = Math.max(0.3, (TRANSITION * Math.abs(to - angle)) / 180);
      const wait = angle === 0 && to > 0 ? (1 - reveal) * REVEAL : 0;
      motion = { from: angle, to, elapsed: -wait, duration };
    }
    if (motion) {
      motion.elapsed += dt;
      const t = Math.min(Math.max(0, motion.elapsed) / motion.duration, 1);
      angle = motion.from + (motion.to - motion.from) * t * t * (3 - 2 * t);
      if (t === 1) motion = null;
    }
    const hovering = now >= SCRIPT.arrive && now < SCRIPT.leave;
    const opening = motion !== null && motion.to > motion.from;
    const target = hovering || opening || angle > 0 ? 1 : 0;
    reveal = target > reveal ? Math.min(target, reveal + dt / REVEAL) : Math.max(target, reveal - dt / REVEAL);
  }
  return { angle, reveal };
}
