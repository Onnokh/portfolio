import { Easing, interpolate } from "remotion";
import { PRESS } from "./timeline";

export type Point = { x: number; y: number };

// Where the cursor is at a time: `keys` in time order, eased between each pair.
export type Path = { t: number; at: Point }[];

const ease = Easing.inOut(Easing.cubic);

function pointAt(path: Path, t: number): Point {
  const next = path.findIndex((key) => key.t > t);
  if (next === -1) return path[path.length - 1].at;
  if (next === 0) return path[0].at;
  const [a, b] = [path[next - 1], path[next]];
  const u = ease((t - a.t) / (b.t - a.t));
  return { x: a.at.x + (b.at.x - a.at.x) * u, y: a.at.y + (b.at.y - a.at.y) * u };
}

// The ring that spreads from a click, in seconds after the release.
const RING = 0.45;

/** A macOS arrow pointer that follows `path` and clicks at each time in `clicks` (the releases). */
export function Cursor({ path, clicks, time, size = 40 }: { path: Path; clicks: number[]; time: number; size?: number }) {
  const at = pointAt(path, time);
  const pressed = clicks.some((click) => time >= click - PRESS && time < click);
  const ring = clicks.map((click) => time - click).find((since) => since >= 0 && since < RING);
  const scale = size / 24;
  const radius = ring === undefined ? 0 : interpolate(ring, [0, RING], [4, 22], { easing: Easing.out(Easing.cubic) });
  return (
    <>
      {ring !== undefined ? (
        <div
          style={{
            position: "absolute",
            left: at.x - radius,
            top: at.y - radius,
            width: 2 * radius,
            height: 2 * radius,
            boxSizing: "border-box",
            borderRadius: "50%",
            border: "1.5px solid rgb(10 10 10 / 0.5)",
            opacity: interpolate(ring, [0, RING], [0.9, 0]),
          }}
        />
      ) : null}
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        style={{
          position: "absolute",
          // The tip of the arrow is at (4, 2) in the view box.
          left: at.x - 4 * scale,
          top: at.y - 2 * scale,
          overflow: "visible",
          transformOrigin: `${4 * scale}px ${2 * scale}px`,
          scale: pressed ? "0.86" : "1",
          filter: "drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35))",
        }}
      >
        <path d="M4 2v17.2l4.6-4.4 2.9 6.7 3.1-1.3-2.9-6.6h6.3Z" fill="#0a0a0a" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </>
  );
}
