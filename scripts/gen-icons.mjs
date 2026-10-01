// Generate the extension's icons: a white-rimmed circle over a field of grey triangles,
// with an #AEFF7E check on top.
// Pure Node, zero deps, builds the PNG by hand (RGBA, 8-bit, deflate).
//
// The drawing happens once, at RENDER_SIZE, and the four shipped sizes are Lanczos-downscaled
// from it. Drawing a 16px icon directly gives hard, ragged triangle edges: the shapes are
// point-tested per pixel, so a pixel on a triangle's edge comes out either fully inside or
// fully outside, with nothing in between. Averaging many pixels of a much larger drawing is
// what produces the intermediate values.
//
// Usage: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---------------- Minimal PNG encoder ---------------- */
// CRC-32 table for the chunk checksums below.
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
/**
 * CRC-32 of a buffer, the flavour PNG chunk checksums use.
 *
 * @param buf the bytes to checksum
 * @returns the checksum as an unsigned 32-bit number
 */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
/**
 * Assemble a PNG chunk: length + type + data + CRC.
 *
 * @param type the four-letter type, e.g. IHDR / IDAT
 * @param data the chunk payload
 * @returns one whole block you can append straight into the PNG byte stream
 */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/**
 * Encode an RGBA bitmap into PNG bytes.
 *
 * @param size side length (square)
 * @param rgba pixel data, length must be size * size * 4
 * @returns the full contents of the PNG file
 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4 + 1; // +1 filter byte per row
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- Drawing (SDF antialiasing) ---------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Distance from a point to the line segment (x1,y1)-(x2,y2).
 *
 * @param px the point's x
 * @param py the point's y
 * @returns the distance
 */
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
/**
 * Shortest distance from a point to a polyline.
 *
 * @param px the point's x
 * @param py the point's y
 * @param pts the polyline's points, as [x, y] pairs
 * @returns the distance
 */
function polylineDist(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d;
}

/**
 * Signed distance from a point to a triangle; negative means inside.
 *
 * Exact rather than the cheaper "max of the three half-planes", which underestimates near a
 * corner and would round the tips off -- the tips are most of what a triangle reads as.
 *
 * @param px the point's x
 * @param py the point's y
 * @param t the triangle's three vertices, as [x, y] pairs
 * @returns the signed distance
 */
function sdTriangle(px, py, t) {
  let inside = true;
  let d = Infinity;
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = t[i];
    const [bx, by] = t[(i + 1) % 3];
    // The vertices are generated at increasing angle starting from straight up, which makes
    // the winding counter-clockwise, so every edge has the interior on its left: a negative
    // cross product means the point is outside.
    if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0) inside = false;
    d = Math.min(d, segDist(px, py, ax, ay, bx, by));
  }
  return inside ? -d : d;
}

/* ---------------- The icon ---------------- */
const SURFACE = [0x1e, 0x21, 0x28]; // --bg-surface
const GREEN = [0xae, 0xff, 0x7e]; // --accent #AEFF7E
const WHITE = [0xff, 0xff, 0xff];

/** The check mark, as [x, y] points normalized to the icon side (0..1). */
const CHECK = [
  [0.28, 0.5],
  [0.44, 0.675],
  [0.735, 0.325],
];

/** Fractions of the icon side. The padding leaves room for the shadow to fade out. */
const PAD = 0.055;
const RING = 0.075; // the white rim, measured inward from the circle's edge
const SHADOW = 0.03; // how far the shadow reaches past the rim
const CHECK_STROKE = 0.115;

/**
 * The two ends of the triangle shading ramp, as RGB.
 *
 * Greys with a faint cool cast, to sit with the blue-ish surface colour. Keeping the light end
 * around 0.6 of the way to white is deliberate: past that the green check starts to lose its
 * edge against the triangles it crosses.
 */
const TRI_DARK = [0x58, 0x5e, 0x6a];
const TRI_LIGHT = [0x9c, 0xa5, 0xb4];

/**
 * The size everything is drawn at before being scaled down. 128 is the largest icon shipped,
 * so this is 8x oversampling for that one and more for the rest.
 */
const RENDER_SIZE = 1024;

/**
 * A small deterministic PRNG (mulberry32).
 *
 * The triangle field has to come out the same on every run, or `npm run icons` would produce
 * a different file each time and the icons could not be checked in.
 *
 * @param seed the starting state
 * @returns a function producing numbers in [0, 1)
 */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scatter the triangles for the background texture.
 *
 * Position, size and shade all vary; the orientation does not -- every triangle sits apex up.
 * They are free to overlap.
 *
 * @param count how many to place
 * @param seed PRNG seed
 * @returns triangles as `{ verts, color }`, with vertices normalized to 0..1
 */
function makeTriangles(count, seed) {
  const random = makeRandom(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const cx = random();
    const cy = random();
    const r = 0.07 + random() * 0.19; // circumradius
    const verts = [0, 1, 2].map((k) => {
      // -90 degrees is straight up, which puts the first vertex at the apex; the other two
      // follow at +120 and +240. Generating them at increasing angles is what keeps the
      // winding consistent, which `sdTriangle` depends on.
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    });
    const t = random();
    const color = TRI_DARK.map((c, i) => Math.round(c + (TRI_LIGHT[i] - c) * t));
    out.push({ verts, color });
  }
  return out;
}

/** The background texture. Fixed seed, so the four sizes share one pattern. */
const TRIANGLES = makeTriangles(12, 0x5eed);

/**
 * Draw the icon at one size, one pixel at a time.
 *
 * Painted bottom to top: the drop shadow, the white rim, then the disc (surface colour, the
 * triangles, the check).
 *
 * @param size side length in pixels
 * @returns RGBA bytes, length size * size * 4
 */
function paint(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radius = half - size * PAD;
  const ringW = size * RING;
  const shadowW = size * SHADOW;
  const checkPts = CHECK.map(([x, y]) => [x * size, y * size]);
  const tris = TRIANGLES.map((t) => ({
    verts: t.verts.map(([x, y]) => [x * size, y * size]),
    color: t.color,
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const circle = Math.hypot(px - half, py - half) - radius;
      const i = (y * size + x) * 4;

      // Bottom layer: a thin dark shadow just outside the rim. It falls off fast, so at 16px
      // it is a faint dark edge and nothing more -- which is the point.
      let alpha = 0;
      let color = [0, 0, 0];
      if (circle > 0) {
        const fade = clamp01(1 - circle / shadowW);
        alpha = 0.34 * fade * fade;
      }

      // The white rim, occupying the outermost `ringW` of the disc.
      const rimSd = Math.max(-ringW - circle, circle);
      const rimA = clamp01(0.5 - rimSd);
      if (rimA > 0) {
        color = WHITE;
        alpha = rimA + alpha * (1 - rimA);
      }

      // The disc: surface colour, then the triangles over it, then the check over those.
      const discA = clamp01(0.5 - (circle + ringW));
      if (discA > 0) {
        let face = SURFACE;
        for (const tri of tris) {
          if (sdTriangle(px, py, tri.verts) <= 0) face = tri.color;
        }
        const d = polylineDist(px, py, checkPts);
        const cov = clamp01(0.5 + (size * CHECK_STROKE * 0.5 - d));
        face = [
          Math.round(GREEN[0] * cov + face[0] * (1 - cov)),
          Math.round(GREEN[1] * cov + face[1] * (1 - cov)),
          Math.round(GREEN[2] * cov + face[2] * (1 - cov)),
        ];
        color = face;
        alpha = discA + alpha * (1 - discA);
      }

      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = Math.round(255 * clamp01(alpha));
    }
  }
  return rgba;
}

/* ---------------- Downscaling (Lanczos-3) ---------------- */

/**
 * The Lanczos kernel, a = 3.
 *
 * @param x distance from the sample point, in output pixels
 * @param a the number of lobes; 3 keeps the ringing low enough not to show on a shape like this
 * @returns the weight
 */
function lanczos(x, a) {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/**
 * Resample an RGBA bitmap with a separable Lanczos filter.
 *
 * Colours are premultiplied by alpha before filtering and divided back out afterwards. Without
 * that, the fully transparent pixels around the circle -- which are black -- would pull the
 * shadow's edge toward black instead of just making it fainter.
 *
 * @param src source pixels, length srcW * srcH * 4
 * @param srcW source width
 * @param srcH source height
 * @param dstW output width
 * @param dstH output height
 * @returns the resampled pixels
 */
function resample(src, srcW, srcH, dstW, dstH) {
  const A = 3;

  // Pass 1: horizontally, srcW -> dstW, keeping every source row.
  const tmp = new Float64Array(dstW * srcH * 4);
  const scaleX = srcW / dstW;
  const supportX = A * scaleX;
  for (let y = 0; y < srcH; y++) {
    const row = y * srcW * 4;
    for (let x = 0; x < dstW; x++) {
      const center = (x + 0.5) * scaleX;
      const lo = Math.max(0, Math.ceil(center - supportX - 0.5));
      const hi = Math.min(srcW - 1, Math.floor(center + supportX - 0.5));
      let sum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let i = lo; i <= hi; i++) {
        const w = lanczos((i + 0.5 - center) / scaleX, A);
        if (w === 0) continue;
        const o = row + i * 4;
        const a = src[o + 3] / 255;
        r += src[o] * a * w;
        g += src[o + 1] * a * w;
        b += src[o + 2] * a * w;
        al += src[o + 3] * w;
        sum += w;
      }
      const o2 = (y * dstW + x) * 4;
      if (sum === 0) continue;
      tmp[o2] = r / sum;
      tmp[o2 + 1] = g / sum;
      tmp[o2 + 2] = b / sum;
      tmp[o2 + 3] = al / sum;
    }
  }

  // Pass 2: vertically, srcH -> dstH, and undo the premultiply.
  const out = Buffer.alloc(dstW * dstH * 4);
  const scaleY = srcH / dstH;
  const supportY = A * scaleY;
  for (let y = 0; y < dstH; y++) {
    const center = (y + 0.5) * scaleY;
    const lo = Math.max(0, Math.ceil(center - supportY - 0.5));
    const hi = Math.min(srcH - 1, Math.floor(center + supportY - 0.5));
    const taps = [];
    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      const w = lanczos((i + 0.5 - center) / scaleY, A);
      if (w === 0) continue;
      taps.push([i, w]);
      sum += w;
    }
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (const [i, w] of taps) {
        const o = (i * dstW + x) * 4;
        r += tmp[o] * w;
        g += tmp[o + 1] * w;
        b += tmp[o + 2] * w;
        al += tmp[o + 3] * w;
      }
      const o2 = (y * dstW + x) * 4;
      if (sum === 0) continue;
      const alpha = al / sum;
      // Below half a step of alpha there is no colour left to recover; writing an arbitrary
      // RGB there would put a dark halo around the shape in viewers that ignore alpha.
      if (alpha <= 0.5) continue;
      const unpremultiply = 255 / alpha;
      out[o2] = clamp255(Math.round((r / sum) * unpremultiply));
      out[o2 + 1] = clamp255(Math.round((g / sum) * unpremultiply));
      out[o2 + 2] = clamp255(Math.round((b / sum) * unpremultiply));
      out[o2 + 3] = clamp255(Math.round(alpha));
    }
  }
  return out;
}

/**
 * Draw the icon once at RENDER_SIZE and keep it, so the four sizes don't each pay for it.
 *
 * @returns RGBA bytes at RENDER_SIZE
 */
let master = null;
function masterRender() {
  if (!master) master = paint(RENDER_SIZE);
  return master;
}

/**
 * Draw one icon.
 *
 * Exported so a scratch script can render one large copy to look at; the loop at the bottom
 * writes the four the extension actually ships.
 *
 * @param size side length, also the width and height of the output PNG in pixels
 * @returns PNG bytes
 */
export function renderIcon(size) {
  return encodePng(size, resample(masterRender(), RENDER_SIZE, RENDER_SIZE, size, size));
}

// Only when run as a script. A scratch script importing `renderIcon` should not also be
// rewriting the shipped files -- and drawing the master copy is slow enough to notice.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const s of [16, 32, 48, 128]) {
    writeFileSync(join(outDir, `${s}.png`), renderIcon(s));
  }
  console.log(`icons written -> ${outDir}`);
}
