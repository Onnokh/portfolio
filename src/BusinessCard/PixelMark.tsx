// "OK" set on a 5-row pixel grid, in the spirit of the reference card's monogram.
export const PIXEL_MARK_ROWS = [
  ".###..##.##",
  "##.##.####.",
  "##.##.###..",
  "##.##.####.",
  ".###..##.##",
];

export function PixelMark({ size = 16 }: { size?: number }) {
  const width = PIXEL_MARK_ROWS[0].length;
  return (
    <svg
      width={(size / PIXEL_MARK_ROWS.length) * width}
      height={size}
      viewBox={`0 0 ${width} ${PIXEL_MARK_ROWS.length}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      role="img"
      aria-label="OK"
    >
      {PIXEL_MARK_ROWS.flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)),
      )}
    </svg>
  );
}
