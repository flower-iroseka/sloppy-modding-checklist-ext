// Generate the extension's placeholder icons: dark grey rounded square + an #AEFF7E check.
// Pure Node, zero deps, builds the PNG by hand (RGBA, 8-bit, deflate).
// Usage: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Signed distance from a point to a rounded rect; negative means inside. We use it to
 * compute coverage for antialiasing.
 *
 * @param px the point's x
 * @param py the point's y
 * @param cx the rect center's x
 * @param cy the rect center's y
 * @param hx half width
 * @param hy half height
 * @param r corner radius
 * @returns the signed distance
 */
function sdRoundedBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

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

const SURFACE = [0x1e, 0x21, 0x28]; // --bg-surface
const GREEN = [0xae, 0xff, 0x7e]; // --accent #AEFF7E
/** The check mark, as [x, y] points normalized to the icon side (0..1). */
const CHECK = [
  [0.26, 0.5],
  [0.43, 0.69],
  [0.76, 0.3],
];

/**
 * Draw one icon.
 *
 * @param size side length, also the width and height of the output PNG in pixels
 * @returns PNG bytes
 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const pad = size * 0.06;
  const radius = size * 0.2;
  const strokeW = size * 0.13;
  const checkPts = CHECK.map(([x, y]) => [x * size, y * size]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sd = sdRoundedBox(x + 0.5, y + 0.5, half, half, half - pad, half - pad, radius);
      const boxA = clamp01(0.5 - sd);
      const i = (y * size + x) * 4;
      if (boxA <= 0) {
        rgba[i + 3] = 0;
        continue;
      }
      const d = polylineDist(x + 0.5, y + 0.5, checkPts);
      const cov = clamp01(0.5 + (strokeW / 2 - d));
      rgba[i] = Math.round(GREEN[0] * cov + SURFACE[0] * (1 - cov));
      rgba[i + 1] = Math.round(GREEN[1] * cov + SURFACE[1] * (1 - cov));
      rgba[i + 2] = Math.round(GREEN[2] * cov + SURFACE[2] * (1 - cov));
      rgba[i + 3] = Math.round(255 * boxA);
    }
  }
  return encodePng(size, rgba);
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `${s}.png`), renderIcon(s));
}
console.log(`icons written -> ${outDir}`);
