/**
 * Pack `dist/` into the zip that gets uploaded to the Chrome Web Store.
 *
 * Written by hand rather than with a zip library or PowerShell: the repo has no zip
 * dependency, PowerShell would tie the script to Windows, and this way the archive is
 * byte-for-byte reproducible (fixed timestamps, sorted entries) so two runs of the same
 * build produce the same file.
 *
 * The output name carries the version from `public/manifest.json`, which is the whole point
 * of the script: the previous package was produced by hand, and the copy left in the repo
 * root said `0.4.0` while the source had moved on.
 *
 * Usage: node scripts/zip.mjs        (normally through `npm run zip`, which builds first)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(root, 'dist');
const OUT_DIR = join(root, 'build');

/** Every entry in a zip is deflated; the extension's files all benefit from it. */
const METHOD_DEFLATE = 8;

/** 1980-01-01 00:00:00 in MS-DOS format: the earliest a zip can express, and a fixed value. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of a buffer, as the zip format wants it.
 *
 * @param buf the bytes to checksum
 * @returns the checksum
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * List every file under a directory, as paths relative to that directory.
 *
 * @param dir the directory to walk
 * @param base the directory the returned paths are relative to; the caller leaves it out
 * @returns relative paths, sorted, so the archive is reproducible
 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/**
 * Build one zip entry: the local header followed by the compressed bytes.
 *
 * @param name entry name, with forward slashes
 * @param raw the file's uncompressed bytes
 * @returns the local header, the compressed data, and what the central directory needs
 */
function buildEntry(name, raw) {
  const nameBytes = Buffer.from(name, 'utf8');
  const deflated = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed to extract
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(METHOD_DEFLATE, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra field length

  return {
    local: Buffer.concat([local, nameBytes]),
    data: deflated,
    crc,
    nameBytes,
    rawLength: raw.length,
  };
}

/**
 * Build the central directory entry for one file.
 *
 * @param entry what `buildEntry` produced
 * @param offset where this file's local header starts
 * @returns the central directory record
 */
function centralEntry(entry, offset) {
  const { nameBytes, crc, data } = entry;
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0, 8); // flags
  head.writeUInt16LE(METHOD_DEFLATE, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(data.length, 20);
  head.writeUInt32LE(entry.rawLength, 24);
  head.writeUInt16LE(nameBytes.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk number
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(0, 38); // external attributes
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, nameBytes]);
}

const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.json'), 'utf8'));
const files = listFiles(DIST);

if (files.length === 0) {
  console.error('dist/ 是空的，先跑一次 npm run build。');
  process.exit(1);
}

const parts = [];
const central = [];
let offset = 0;

for (const rel of files) {
  const raw = readFileSync(join(DIST, rel));
  const entry = buildEntry(rel.split(sep).join('/'), raw);
  parts.push(entry.local, entry.data);
  central.push(centralEntry(entry, offset));
  offset += entry.local.length + entry.data.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...parts, centralBuf, end]);
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, `sloppy-modding-checklist-${manifest.version}.zip`);
writeFileSync(out, zip);

console.log(`${out}\n${files.length} 个文件，${(zip.length / 1024).toFixed(1)} KB，manifest 版本 ${manifest.version}`);
