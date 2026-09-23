import { BODY, INNER_SCREEN, OUTER_SCREEN } from "./geometry";

const f = (n: number) => n.toFixed(6);

// Ported from the iPhone Duo fold preview (chuspeeism/iphone-duo, MIT): the hinge rotation, the
// Hermite bend of the flexible strip, and the screen shader with its fixed front-view projection,
// progressive blur and darkening. The body lighting stands in for three.js' RoomEnvironment,
// hemisphere, key and rim lights, with the same ACES filmic tone mapping.
export const bodyShader = /* wgsl */ `
struct Scene {
  viewProjection: mat4x4f,
  eye: vec3f,
  foldAngle: f32,
  innerFrame: vec4f,
  outerFrame: vec4f,
  innerPixel: vec2f,
  outerPixel: vec2f,
  innerBlur: f32,
  outerBlur: f32,
  outerOn: f32,
  exposure: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var innerMap: texture_2d<f32>;
@group(0) @binding(2) var outerMap: texture_2d<f32>;
@group(0) @binding(3) var mapSampler: sampler;

const HINGE_Z = ${f(BODY.hingeZ)};
const HINGE_HALF = ${f(BODY.hingeHalfWidth)};
const SCREEN_Z = ${f(BODY.top)};
const PI = 3.141592654;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec2f,
  @location(3) @interpolate(flat) face: u32,
  // Sideways growth this point would get from full perspective (see vs_main).
  @location(4) grow: f32,
}

fn rotateHinge(p: vec2f) -> vec2f {
  let c = cos(scene.foldAngle);
  let s = sin(scene.foldAngle);
  let q = vec2f(p.x, p.y - HINGE_Z);
  return vec2f(c * q.x + s * q.y, -s * q.x + c * q.y + HINGE_Z);
}

// Folded (x, z) and the surface tangent in the xz-plane. Right of the strip nothing moves, left of
// it everything rotates about the hinge, and inside it a Hermite curve joins the two.
fn bendStrip(p: vec2f) -> vec4f {
  let a = scene.foldAngle;
  if (p.x >= HINGE_HALF) { return vec4f(p, 1.0, 0.0); }
  if (p.x <= -HINGE_HALF) { return vec4f(rotateHinge(p), cos(a), -sin(a)); }
  let t = (p.x + HINGE_HALF) / (2.0 * HINGE_HALF);
  let t2 = t * t;
  let t3 = t2 * t;
  let pa = rotateHinge(vec2f(-HINGE_HALF, p.y));
  let pb = vec2f(HINGE_HALF, p.y);
  let ta = 2.0 * HINGE_HALF * vec2f(cos(a), -sin(a));
  let tb = vec2f(2.0 * HINGE_HALF, 0.0);
  let point = (2.0 * t3 - 3.0 * t2 + 1.0) * pa + (t3 - 2.0 * t2 + t) * ta
    + (-2.0 * t3 + 3.0 * t2) * pb + (t3 - t2) * tb;
  let tangent = normalize((6.0 * t2 - 6.0 * t) * pa + (3.0 * t2 - 4.0 * t + 1.0) * ta
    + (-6.0 * t2 + 6.0 * t) * pb + (3.0 * t2 - 2.0 * t) * tb);
  return vec4f(point, tangent);
}

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) face: f32) -> VertexOut {
  let folded = bendStrip(position.xz);
  let a = atan2(-folded.w, folded.z);
  // Perspective comes from how far the cover has lifted off its resting plane, not from its depth:
  // closed, the cover lies on top of the stack but draws at exactly the size of the page under it.
  // Only the vertical half of perspective is kept. The free edge grows taller as it lifts, which is
  // what reads as the tilt; the sideways push toward the viewer is dropped, because near both ends
  // it outgrows the shrinking width and swings the edge out past the content it covers.
  // Depth stays real for occlusion.
  let rest = cos(a) * (position.z - HINGE_Z) + HINGE_Z;
  let lift = max(0.0, folded.y - rest);
  let toPlane = (scene.eye.z - folded.y) / (scene.eye.z - SCREEN_Z);
  let grow = (scene.eye.z - SCREEN_Z) / (scene.eye.z - SCREEN_Z - lift);
  let world = vec3f(
    scene.eye.x + (folded.x - scene.eye.x) * toPlane,
    scene.eye.y + (position.y - scene.eye.y) * toPlane * grow,
    folded.y,
  );
  var out: VertexOut;
  out.position = scene.viewProjection * vec4f(world, 1.0);
  out.world = world;
  out.normal = vec3f(cos(a) * normal.x + sin(a) * normal.z, normal.y, -sin(a) * normal.x + cos(a) * normal.z);
  out.local = position.xy;
  out.face = u32(face + 0.5);
  out.grow = grow;
  return out;
}

// Intersect the fixed front-view ray with the unfolded inner-screen plane.
fn projectToScreen(p: vec3f) -> vec2f {
  let depth = (SCREEN_Z - scene.eye.z) / (p.z - scene.eye.z);
  return scene.eye.xy + (p.xy - scene.eye.xy) * depth;
}

fn innerUV(p: vec3f) -> vec2f {
  let projected = projectToScreen(p);
  let uv = (projected - scene.innerFrame.xy) / scene.innerFrame.zw;
  return vec2f(uv.x, 1.0 - uv.y);
}

// The reference anchors the outer image to the moving hinge-side edge. The card pins it in screen
// space instead, like the inner image, so the front never slides while the cover lifts.
fn outerUV(p: vec3f) -> vec2f {
  let uv = (projectToScreen(p) - scene.outerFrame.xy) / scene.outerFrame.zw;
  return vec2f(uv.x, 1.0 - uv.y);
}

fn screenAt(inner: bool, uv: vec2f, lod: f32) -> vec3f {
  if (inner) { return textureSampleLevel(innerMap, mapSampler, uv, lod).rgb; }
  return textureSampleLevel(outerMap, mapSampler, uv, lod).rgb;
}

fn screenColor(inner: bool, uv: vec2f, pixel: vec2f, footprint: vec2f, edge: f32, progress: f32, maxBlur: f32) -> vec3f {
  let motion = smoothstep(0.0, 1.0, progress);
  let blurGradient = clamp(edge, 0.0, 1.0);
  let darkenGradient = clamp((edge - 0.2) / 0.8, 0.0, 1.0);
  let effect = motion * pow(darkenGradient, 1.35);
  let radius = maxBlur * motion * pow(blurGradient, 1.35);
  let aa = max(footprint, pixel * 0.5);
  let baseLod = log2(max(1.0, max(footprint.x / pixel.x, footprint.y / pixel.y)));
  let coverage = smoothstep(-aa, aa, uv) * (1.0 - smoothstep(vec2f(1.0) - aa, vec2f(1.0) + aa, uv));
  var color = screenAt(inner, clamp(uv, vec2f(0.0), vec2f(1.0)), baseLod) * coverage.x * coverage.y;
  if (radius > 0.0) {
    // Same mip level at zero blur, then rising with the radius.
    let lod = max(baseLod, log2(max(1.0, radius)));
    let spread = max(aa, pixel * radius * 0.75);
    color = vec3f(0.0);
    for (var y = -2; y <= 2; y++) {
      for (var x = -2; x <= 2; x++) {
        let wx = select(select(1.0, 4.0, abs(x) == 1), 6.0, x == 0);
        let wy = select(select(1.0, 4.0, abs(y) == 1), 6.0, y == 0);
        let sampleUV = uv + vec2f(f32(x), f32(y)) * pixel * radius;
        // Blur the image and its coverage together, so colour spreads into the black margin.
        let cover = smoothstep(-spread, spread, sampleUV) * (1.0 - smoothstep(vec2f(1.0) - spread, vec2f(1.0) + spread, sampleUV));
        color += screenAt(inner, clamp(sampleUV, vec2f(0.0), vec2f(1.0)), lod)
          * cover.x * cover.y * wx * wy / 256.0;
      }
    }
  }
  return color * (1.0 - min(1.0, effect * 2.0));
}

fn sdRoundRect(p: vec2f, center: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let q = abs(p - center) - halfSize + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// Rounded on the left, square on the right: the outer screen's corners at the fold.
fn sdRoundRectLeft(p: vec2f, center: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  return sdRoundRect(p, center, halfSize, select(radius, 0.0, p.x > center.x));
}

// A room-like environment: soft grey walls, a brighter ceiling, and a few light panels.
fn softbox(d: vec3f, axis: vec3f, size: f32, rough: f32) -> f32 {
  let spread = size + rough * 0.9;
  return smoothstep(cos(spread), cos(spread * 0.35), dot(d, normalize(axis)));
}

fn environment(d: vec3f, rough: f32) -> vec3f {
  let room = mix(vec3f(0.26, 0.26, 0.25), vec3f(0.78, 0.78, 0.77), smoothstep(-0.8, 0.9, d.y));
  var light = softbox(d, vec3f(0.0, 1.0, 0.25), 0.42, rough) * 5.0;
  light += softbox(d, vec3f(-0.95, 0.35, 0.35), 0.28, rough) * 4.0;
  light += softbox(d, vec3f(0.95, 0.25, -0.2), 0.3, rough) * 3.0;
  light += softbox(d, vec3f(0.1, 0.45, 1.0), 0.22, rough) * 2.5;
  light += softbox(d, vec3f(0.0, 0.6, -1.0), 0.35, rough) * 2.0;
  return room + vec3f(light) * (1.0 - rough * 0.55);
}

fn fresnel(f0: vec3f, cosTheta: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
}

fn ggx(n: vec3f, v: vec3f, l: vec3f, rough: f32) -> f32 {
  let h = normalize(v + l);
  let a = rough * rough;
  let a2 = a * a;
  let nh = max(dot(n, h), 0.0);
  let d = nh * nh * (a2 - 1.0) + 1.0;
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let k = a * 0.5;
  let vis = 1.0 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
  return a2 / (PI * d * d) * vis * 0.25;
}

fn shade(n: vec3f, v: vec3f, albedo: vec3f, metal: f32, rough: f32) -> vec3f {
  let f0 = mix(vec3f(0.04), albedo, metal);
  let diffuse = albedo * (1.0 - metal) / PI;
  let nv = max(dot(n, v), 1e-3);
  let lights = array<vec3f, 2>(normalize(vec3f(-15.0, 25.0, 30.0)), normalize(vec3f(15.0, 5.0, -15.0)));
  let colors = array<vec3f, 2>(vec3f(1.0, 0.988, 0.961) * 2.6, vec3f(0.91, 0.93, 0.96) * 2.0);
  var color = vec3f(0.0);
  for (var i = 0; i < 2; i++) {
    let l = lights[i];
    let nl = max(dot(n, l), 0.0);
    let h = normalize(v + l);
    color += colors[i] * nl * (diffuse + fresnel(f0, max(dot(v, h), 0.0)) * ggx(n, v, l, rough));
  }
  let hemisphere = mix(vec3f(0.71, 0.73, 0.66), vec3f(1.0), n.y * 0.5 + 0.5) * 1.8;
  color += diffuse * (hemisphere + environment(n, 1.0) * 1.35 * PI * 0.5);
  let r = reflect(-v, n);
  color += environment(r, rough) * fresnel(f0, nv) * 1.35 * (1.0 - rough * 0.6);
  return color;
}

// three.js ACESFilmicToneMapping.
fn aces(input: vec3f) -> vec3f {
  let inputMat = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
  let outputMat = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
  var color = inputMat * (input * scene.exposure / 0.6);
  let a = color * (color + 0.0245786) - 0.000090537;
  let b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outputMat * (a / b);
  return clamp(color, vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Everything that needs derivatives runs before the branches.
  let uvIn = innerUV(in.world);
  let uvOut = outerUV(in.world);
  let footprintIn = fwidth(uvIn);
  let footprintOut = fwidth(uvOut);
  let inner = sdRoundRect(in.local, vec2f(${f(INNER_SCREEN.x + INNER_SCREEN.width / 2)}, ${f(INNER_SCREEN.y + INNER_SCREEN.height / 2)}),
    vec2f(${f(INNER_SCREEN.width / 2)}, ${f(INNER_SCREEN.height / 2)}), ${f(INNER_SCREEN.radius)});
  let outer = sdRoundRectLeft(in.local, vec2f(${f(OUTER_SCREEN.x + OUTER_SCREEN.width / 2)}, ${f(OUTER_SCREEN.y + OUTER_SCREEN.height / 2)}),
    vec2f(${f(OUTER_SCREEN.width / 2)}, ${f(OUTER_SCREEN.height / 2)}), ${f(OUTER_SCREEN.radius)});
  let innerMask = 1.0 - smoothstep(-fwidth(inner), fwidth(inner), inner);
  let outerMask = 1.0 - smoothstep(-fwidth(outer), fwidth(outer), outer);

  let n = normalize(in.normal);
  let v = normalize(scene.eye - in.world);

  // Frame: satin titanium. It also covers the bending strip's outside, which is the hinge: the
  // spine when closed, the rounded fold while the cover is up. No screen reaches onto it.
  let frame = aces(shade(n, v, vec3f(0.86, 0.85, 0.82), 1.0, 0.32));
  if (in.face == 2u || (in.face == 1u && abs(in.local.x) < HINGE_HALF)) {
    return vec4f(frame, 1.0);
  }

  // Screens are unlit, like the reference's MeshBasicMaterial: content inside the panel, black
  // in the border around it.
  if (in.face == 0u) {
    let progress = clamp(scene.foldAngle / (PI * 0.5), 0.0, 1.0);
    // The reference measures blur and darkening where full perspective would put this point. The
    // cover here gets no sideways growth, so scale its distance from the hinge back up by it.
    let edge = (uvIn.x - 0.5) / (0.0 - 0.5) * in.grow;
    let screen = screenColor(true, uvIn, scene.innerPixel, footprintIn, edge, progress, scene.innerBlur);
    return vec4f(screen * innerMask, 1.0);
  }

  if (in.local.x < 0.0) {
    let progress = clamp((PI - scene.foldAngle) / (PI * 0.5), 0.0, 1.0);
    var screen = screenColor(false, uvOut, scene.outerPixel, footprintOut, uvOut.x * in.grow, progress, scene.outerBlur);
    // The front image starts where the screen's fold-side edge lies when closed. As the cover
    // lifts, that edge swings toward the fold, and the screen between it and the front image shows
    // the inside page that lies there once the card is open. The two cross-fade over the front's
    // edge coverage, so there is no seam.
    let aa = max(footprintOut.x, scene.outerPixel.x * 0.5);
    let beyond = 1.0 - smoothstep(-aa, aa, uvOut.x);
    if (beyond > 0.0) {
      screen += screenColor(true, uvIn, scene.innerPixel, footprintIn, 0.0, 0.0, 0.0) * beyond;
    }
    // Outside the screen, the cover is black bezel.
    return vec4f(screen * scene.outerOn * outerMask, 1.0);
  }
  // Back of the fixed half: frosted white glass.
  return vec4f(aces(shade(n, v, vec3f(0.9, 0.89, 0.86), 0.0, 0.45)), 1.0);
}
`;

// Resolve the MSAA scene onto the canvas: linear to sRGB, premultiplied for a transparent page.
export const presentShader = /* wgsl */ `
@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

fn toSrgb(c: vec3f) -> vec3f {
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3f(0.0031308));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = textureSampleLevel(sceneColor, sceneSampler, uv, 0.0);
  if (texel.a <= 0.0) { return vec4f(0.0); }
  let color = toSrgb(clamp(texel.rgb / texel.a, vec3f(0.0), vec3f(1.0)));
  return vec4f(color * texel.a, texel.a);
}
`;

// The card's shadow on the page, drawn behind it on its own canvas. The light is above the card, to
// the upper right, so a shadow falls a little left and down the page, the same way open or closed.
// The higher a part of the card is off the page, the further its shadow falls, the softer it is and
// the fainter. The fixed half lies
// on the page. The cover's lift grows along its width, from nothing at the hinge to its free edge,
// so its shadow leans away and softens toward that edge as the card opens and closes.
export const shadowShader = /* wgsl */ `
struct Shadow {
  // Model units the canvas spans on the card's plane, and the view's pan (see viewCenter).
  extent: vec2f,
  center: f32,
  foldAngle: f32,
  // The bent strip's leftmost point over the page (see spineEdge).
  spine: f32,
}

@group(0) @binding(0) var<uniform> shadow: Shadow;

const HALF_WIDTH = ${f(BODY.halfWidth)};
const HALF_HEIGHT = ${f(BODY.halfHeight)};
const RADIUS = ${f(BODY.cornerRadius)};
// The hinge side of each half is square, softened only by the frame's round edge.
const SPINE_RADIUS = ${f((BODY.top - BODY.bottom) / 2)};
// Where the cover still lies open, the two halves overlap by this much, so no seam shows between
// their shadows.
const OVERLAP = 1.0;
const COLOR = vec3f(0.11, 0.1, 0.08);
// The way a shadow falls on the page, away from the light.
const FALL = vec2f(-0.8, -0.6);

// A tight contact shadow and a wide, faint one under it. Blur and drop are in model units, at rest
// and per unit of lift.
struct Layer {
  opacity: f32,
  blur: f32,
  blurPerLift: f32,
  drop: f32,
  dropPerLift: f32,
}

// A rounded rectangle from lo.x to hi.x, with its own corner radius on each side.
fn sdBox(p: vec2f, lo: f32, hi: f32, radiusLo: f32, radiusHi: f32) -> f32 {
  let center = vec2f((lo + hi) / 2.0, 0.0);
  let size = vec2f((hi - lo) / 2.0, HALF_HEIGHT);
  let r = min(select(radiusLo, radiusHi, p.x > center.x), size.x);
  let q = abs(p - center) - size + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// The normal distribution's CDF, closely enough: what a gaussian blur leaves at signed distance x.
fn phi(x: f32) -> f32 {
  return 1.0 / (1.0 + exp(-1.702 * x));
}

fn term(p: vec2f, lo: f32, hi: f32, radiusLo: f32, radiusHi: f32, lift: f32, layer: Layer) -> f32 {
  let sigma = layer.blur + layer.blurPerLift * lift;
  let q = p - FALL * (layer.drop + layer.dropPerLift * lift);
  // A box narrower than its blur gives less than half its shadow even in the middle. tanh is 1 long
  // before 10, and larger inputs overflow to NaN on some GPUs.
  let thin = tanh(min(0.43 * (hi - lo) / sigma, 10.0));
  return layer.opacity * thin * phi(-sdBox(q, lo, hi, radiusLo, radiusHi) / sigma) / (1.0 + 0.2 * lift);
}

fn layerShadow(p: vec2f, layer: Layer) -> f32 {
  let open = cos(shadow.foldAngle);
  // Where the cover's free edge lies over the page: left of the hinge while open, over the fixed
  // half while closed.
  let free = -HALF_WIDTH * open;
  let overlap = OVERLAP * max(open, 0.0);
  let below = term(p, shadow.spine - overlap, HALF_WIDTH, SPINE_RADIUS, RADIUS, 0.0, layer);
  // How far the cover is lifted above this point: its distance from the hinge, up the fold.
  let along = select(0.0, clamp(p.x / free, 0.0, 1.0), abs(free) > 1e-4);
  let lift = along * HALF_WIDTH * sin(shadow.foldAngle);
  // Its hinge end is the spine; while open, it also runs under the fixed half.
  let lo = min(free, shadow.spine);
  let hi = max(free, overlap);
  let freeRadius = min(RADIUS, abs(free) / 2.0);
  let cover = term(p, lo, hi, select(SPINE_RADIUS, freeRadius, free < 0.0), select(SPINE_RADIUS, freeRadius, free > 0.0), lift, layer);
  return max(below, cover);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = vec2f((uv.x - 0.5) * shadow.extent.x + shadow.center, (0.5 - uv.y) * shadow.extent.y);
  let contact = layerShadow(p, Layer(0.55, 0.05, 0.12, 0.16, 0.12));
  let ambient = layerShadow(p, Layer(0.14, 0.4, 0.22, 0.3, 0.2));
  // Fade out toward the canvas edges, so a wide shadow never ends on a hard line.
  let edge = smoothstep(vec2f(0.0), vec2f(0.06), uv) * smoothstep(vec2f(0.0), vec2f(0.06), vec2f(1.0) - uv);
  let alpha = (1.0 - (1.0 - contact) * (1.0 - ambient)) * edge.x * edge.y;
  return vec4f(COLOR * alpha, alpha);
}
`;
