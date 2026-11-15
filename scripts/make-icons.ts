// Generates the PWA icons: gold triangle (Pyramid mark) on a teal field.
// Pure TypeScript + node:zlib, no image libraries. Run: bun scripts/make-icons.ts
// The triangle is drawn with 4x4 supersampling so the edges are smooth.
// The mark sits inside the maskable safe zone (central 80%).

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const TEAL = [15, 82, 87, 255]; // #0F5257
const GOLD = [244, 201, 93, 255]; // #F4C95D

// CRC32 (PNG chunk checksums).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function pngEncode(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Raw scanlines: filter byte 0 + RGBA per pixel.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// Point-in-triangle test (sign method).
function inTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function rasterize(size: number): Buffer {
  const SS = 4; // 4x4 supersampling
  const rgba = Buffer.alloc(size * size * 4);
  // Triangle geometry (fractions of size).
  const ax = 0.5, ay = 0.16;
  const bx = 0.15, by = 0.84;
  const cx = 0.85, cy = 0.84;
  // Horizontal chord (pyramid read): a teal band across the triangle.
  const chordTop = 0.58, chordBottom = 0.63;
  // Small teal dot near the bottom of the triangle.
  const dotX = 0.5, dotY = 0.74, dotR = 0.035;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let gold = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (!inTriangle(px, py, ax, ay, bx, by, cx, cy)) continue;
          if (py >= chordTop && py <= chordBottom) continue; // chord cuts the gold
          const dx = px - dotX, dy = py - dotY;
          if (dx * dx + dy * dy < dotR * dotR) continue; // dot cuts the gold
          gold++;
        }
      }
      const t = gold / (SS * SS);
      const o = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) {
        rgba[o + c] = Math.round(TEAL[c] + (GOLD[c] - TEAL[c]) * t);
      }
    }
  }
  return rgba;
}

const OUT = join(import.meta.dir, "..", "public", "icons");
for (const size of [192, 512]) {
  const png = pngEncode(size, size, rasterize(size));
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`wrote public/icons/icon-${size}.png (${png.length} bytes)`);
}
