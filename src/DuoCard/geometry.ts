// Card body in model units. The proportions follow the iPhone Duo reference: an open inner screen
// of 15.8 × 11.1 units, a hinge axis just above the inner screen, and a cover half that folds
// toward the camera onto the fixed half. The height and the corners depend on the layout (see
// Shape); everything here is the same in every layout.

export const BODY = {
  halfWidth: 8.3,
  top: 0.24948,
  bottom: -0.16,
  // Hinge axis height. Folding around a line slightly above the inner screen leaves a thin gap
  // between the two halves of the inner screen when the card is closed.
  hingeZ: 0.275454,
  // Half width of the strip that bends instead of rotating.
  hingeHalfWidth: 0.35,
} as const;

// The inner screen spans both halves; the outer screen covers the back of the cover half. Across,
// both are the same in every layout.
export const INNER_SCREEN = { x: -7.9, width: 15.8 } as const;
// The outside of the bent strip is the hinge, metal at every angle. Like the reference's outer
// panel, the outer screen is part of the rigid cover and stops short of the hinge, with a black band
// between the two: the same border as on the other sides. Its corners at the fold are square.
const FOLD_BORDER = BODY.hingeHalfWidth + 0.2;
export const OUTER_SCREEN = { x: -7.9, width: 7.9 - FOLD_BORDER } as const;

// The front of the card as it lies on screen when closed: the outer screen, folded onto the fixed
// half. The inside right page lays out in this same box, so everything on the front sits exactly
// on top of its copy inside.
export const FRONT_PAGE = { x: -(OUTER_SCREEN.x + OUTER_SCREEN.width), width: OUTER_SCREEN.width } as const;

// The black border between the screens and the body's edge.
const BEZEL = 0.4;

/**
 * What differs between the layouts: how tall the card is, and its corners. Both screens are
 * `screenHeight` tall and centred on y = 0, with corners of `screenRadius`.
 */
export type Shape = { halfHeight: number; cornerRadius: number; screenHeight: number; screenRadius: number };

// The card on a page, in the reference's proportions.
export const CARD_SHAPE: Shape = { halfHeight: 5.95, cornerRadius: 1.05, screenHeight: 11.1, screenRadius: 0.62 };

/**
 * The card that fills a phone's screen, one page at a time: each page has the screen's shape,
 * `aspect` = width / height. The screens' corners are square, since the phone rounds its own, and
 * the body's corners round about the screens' at the bezel's width.
 */
export function fullscreenShape(aspect: number): Shape {
  const screenHeight = INNER_SCREEN.width / 2 / aspect;
  return { halfHeight: screenHeight / 2 + BEZEL, cornerRadius: BEZEL, screenHeight, screenRadius: 0 };
}

/**
 * How the card is shown: on the page, whole and centred, or filling the screen of a phone held
 * upright, whose view has the shape `aspect` = width / height.
 */
export type Layout = { kind: "page" } | { kind: "fullscreen"; aspect: number };

export const layoutShape = (layout: Layout) => (layout.kind === "page" ? CARD_SHAPE : fullscreenShape(layout.aspect));

export const enum Face {
  Inner = 0,
  Outer = 1,
  Frame = 2,
}

// position.xyz, normal.xyz, face
const STRIDE = 7;

/**
 * Builds the body as one closed mesh: the inner face, the outer face, and a rounded frame that
 * joins them. Every part is split into columns across x, dense inside the hinge strip, so the
 * vertex shader can bend it there.
 */
export function buildBody({ halfHeight, cornerRadius }: Shape) {
  const { halfWidth, top, bottom, hingeHalfWidth } = BODY;
  const thickness = top - bottom;
  const edge = thickness / 2;
  const middle = (top + bottom) / 2;
  // The flat faces stop where the rounded frame begins.
  const w = halfWidth - edge;
  const h = halfHeight - edge;
  const r = cornerRadius - edge;

  // Outline of the upper half (y >= 0), left to right, as columns with their outward normals.
  type Column = { x: number; y: number; nx: number; ny: number };
  const columns: Column[] = [];
  const ARC = 18;
  for (let i = 0; i <= ARC; i++) {
    const a = (i / ARC) * (Math.PI / 2);
    columns.push({
      x: -(w - r) - r * Math.cos(a),
      y: h - r + r * Math.sin(a),
      nx: -Math.cos(a),
      ny: Math.sin(a),
    });
  }
  const STRIP = 40;
  const straight = [-(w - r), -hingeHalfWidth * 2];
  for (let i = 0; i <= STRIP; i++) straight.push(-hingeHalfWidth * 2 + (i / STRIP) * hingeHalfWidth * 4);
  straight.push(w - r);
  for (const x of straight.slice(1)) columns.push({ x, y: h, nx: 0, ny: 1 });
  for (let i = ARC - 1; i >= 0; i--) {
    const a = (i / ARC) * (Math.PI / 2);
    columns.push({
      x: w - r + r * Math.cos(a),
      y: h - r + r * Math.sin(a),
      nx: Math.cos(a),
      ny: Math.sin(a),
    });
  }

  const vertices: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, face: Face) => {
    vertices.push(x, y, z, nx, ny, nz, face);
    return vertices.length / STRIDE - 1;
  };

  // Flat faces: one quad per column pair, from the lower outline to the upper outline.
  for (const [z, nz, face] of [
    [top, 1, Face.Inner],
    [bottom, -1, Face.Outer],
  ] as const) {
    const lower: number[] = [];
    const upper: number[] = [];
    for (const c of columns) {
      lower.push(push(c.x, -c.y, z, 0, 0, nz, face));
      upper.push(push(c.x, c.y, z, 0, 0, nz, face));
    }
    for (let i = 0; i < columns.length - 1; i++) {
      const [a, b, c, d] = [lower[i], lower[i + 1], upper[i + 1], upper[i]];
      if (nz > 0) indices.push(a, b, c, a, c, d);
      else indices.push(a, c, b, a, d, c);
    }
  }

  // Frame: a closed loop around the outline, swept through a half-round profile.
  const loop: Column[] = [
    ...columns,
    ...columns
      .slice()
      .reverse()
      .map((c) => ({ x: c.x, y: -c.y, nx: c.nx, ny: -c.ny })),
  ];
  const PROFILE = 12;
  const rings: number[][] = [];
  for (const c of loop) {
    const ring: number[] = [];
    for (let j = 0; j <= PROFILE; j++) {
      const b = -Math.PI / 2 + (j / PROFILE) * Math.PI;
      const out = edge * Math.cos(b);
      ring.push(
        push(c.x + c.nx * out, c.y + c.ny * out, middle + edge * Math.sin(b), c.nx * Math.cos(b), c.ny * Math.cos(b), Math.sin(b), Face.Frame),
      );
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length; i++) {
    const a = rings[i];
    const b = rings[(i + 1) % rings.length];
    for (let j = 0; j < PROFILE; j++) indices.push(a[j], b[j + 1], b[j], a[j], a[j + 1], b[j + 1]);
  }

  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
