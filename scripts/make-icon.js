/*
 * Generates scripts/cmg.ico — the Start-menu icon for the CMG shortcut.
 *
 * Kept as a generator rather than a committed binary so the mark can be
 * re-read and adjusted: it is the app's one accent (indigo) behind the same
 * check that marks a finished sub-lesson. Zero dependencies; the PNG encoder
 * below is a few lines because Node already ships zlib.
 *
 *   node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ACCENT = [0x63, 0x66, 0xf1]; // --accent #6366f1
const SIZES = [16, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor — the only antialiasing this has

/* ---------- geometry, in a 256-unit design space ---------- */

const roundRect = (x, y, w, h, r) => (px, py) => {
  const dx = Math.max(x + r - px, 0, px - (x + w - r));
  const dy = Math.max(y + r - py, 0, py - (y + h - r));
  return Math.hypot(dx, dy) <= r;
};

// Distance to a polyline, so the check gets round caps and a round joint for
// free — a mitred join reads as a spike once it is scaled down to 16px.
const stroke = (points, width) => (px, py) => {
  const half = width / 2;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2));
    if (Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) <= half) return true;
  }
  return false;
};

const plate = roundRect(6, 6, 244, 244, 56);
const check = stroke([[76, 130], [114, 170], [182, 90]], 30);

/* ---------- rasterise ---------- */

function render(size) {
  const n = size * SS;
  const scale = 256 / n;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inPlate = 0, inCheck = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x * SS + sx) + 0.5) * scale;
          const v = ((y * SS + sy) + 0.5) * scale;
          if (plate(u, v)) inPlate++;
          if (check(u, v)) inCheck++;
        }
      }
      const total = SS * SS;
      const a = inPlate / total;
      const c = Math.min(inCheck / total, a); // the check never leaves the plate
      const o = (y * size + x) * 4;
      // white check composited over the accent, both premultiplied by coverage
      for (let k = 0; k < 3; k++) {
        px[o + k] = Math.round(((a - c) * ACCENT[k] + c * 255) / (a || 1));
      }
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/* ---------- PNG ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12: deflate, adaptive filtering, no interlace — all zero

  // filter byte 0 (None) per scanline; the images are tiny, so nothing is
  // gained by searching filter types
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO ---------- */

const images = SIZES.map(size => ({ size, data: png(size, render(size)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; // 256 is encoded as 0
  e[1] = size >= 256 ? 0 : size;
  e[2] = 0;  // palette size
  e[3] = 0;  // reserved
  e.writeUInt16LE(1, 4);   // colour planes
  e.writeUInt16LE(32, 6);  // bits per pixel
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});

const out = path.join(__dirname, 'cmg.ico');
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map(i => i.data)]));
console.log(`wrote ${out} (${SIZES.join(', ')} px, ${fs.statSync(out).size} bytes)`);
