#!/usr/bin/env node
// Regenerates apps/site/public/favicon.ico from the same placeholder design as
// favicon.svg (a rounded dark square with a light "X" monogram).
//
// The site ships a placeholder brand icon (task 07.5, D25). Replace
// public/favicon.svg and public/favicon.ico with real artwork later; this
// script only exists so the .ico can be rebuilt without a new dependency.
// It writes a single 32x32 uncompressed BGRA icon (supported everywhere),
// with 4x4 supersampling for smooth edges.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 32;
const SAMPLES = 4; // 4x4 supersampling per pixel

const BACKGROUND = [0x1b, 0x1b, 0x1b];
const MARK = [0xf5, 0xf5, 0xf5];

/** Distance from a point to a line segment, in icon units. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSquared = abx * abx + aby * aby;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSquared));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

/** Coverage in [0,1] of a rounded square with corner radius `radius`. */
function insideRoundedSquare(px, py, inset, radius) {
  const min = inset;
  const max = SIZE - inset;
  if (px < min || py < min || px > max || py > max) return false;
  const cx = Math.max(min + radius, Math.min(max - radius, px));
  const cy = Math.max(min + radius, Math.min(max - radius, py));
  return Math.hypot(px - cx, py - cy) <= radius || (px >= min + radius && px <= max - radius) || (py >= min + radius && py <= max - radius);
}

// Sample the icon: returns [r, g, b, a] (a in 0..1).
function samplePixel(x, y) {
  let backgroundHits = 0;
  let markHits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const px = x + (sx + 0.5) / SAMPLES;
      const py = y + (sy + 0.5) / SAMPLES;
      if (!insideRoundedSquare(px, py, 3, 9)) continue;
      backgroundHits += 1;
      const inX =
        segmentDistance(px, py, 11.5, 11.5, 20.5, 20.5) <= 3.1 ||
        segmentDistance(px, py, 20.5, 11.5, 11.5, 20.5) <= 3.1;
      if (inX) markHits += 1;
    }
  }
  const total = SAMPLES * SAMPLES;
  const alpha = backgroundHits / total;
  if (alpha === 0) return [0, 0, 0, 0];
  const markShare = markHits / Math.max(1, backgroundHits);
  const rgb = BACKGROUND.map((channel, index) => Math.round(channel * (1 - markShare) + MARK[index] * markShare));
  return [rgb[0], rgb[1], rgb[2], alpha];
}

const xor = Buffer.alloc(SIZE * SIZE * 4);
// BMP rows are bottom-up and BGRA.
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const [r, g, b, a] = samplePixel(x, SIZE - 1 - y);
    const offset = (y * SIZE + x) * 4;
    xor[offset] = b;
    xor[offset + 1] = g;
    xor[offset + 2] = r;
    xor[offset + 3] = Math.round(a * 255);
  }
}
// AND mask: 1 bit per pixel, rows padded to 32 bits. Zero means "paint".
const andMask = Buffer.alloc(SIZE * 4);

const header = Buffer.alloc(40);
header.writeUInt32LE(40, 0); // biSize
header.writeInt32LE(SIZE, 4); // biWidth
header.writeInt32LE(SIZE * 2, 8); // biHeight (XOR + AND)
header.writeUInt16LE(1, 12); // biPlanes
header.writeUInt16LE(32, 14); // biBitCount
header.writeUInt32LE(0, 16); // biCompression = BI_RGB
header.writeUInt32LE(xor.length + andMask.length, 20); // biSizeImage

const image = Buffer.concat([header, xor, andMask]);

const directory = Buffer.alloc(6);
directory.writeUInt16LE(0, 0); // reserved
directory.writeUInt16LE(1, 2); // type: icon
directory.writeUInt16LE(1, 4); // one image

const entry = Buffer.alloc(16);
entry[0] = SIZE; // width
entry[1] = SIZE; // height
entry[2] = 0; // palette colours
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bit count
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(6 + 16, 12);

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
mkdirSync(publicDir, { recursive: true });
const target = join(publicDir, 'favicon.ico');
writeFileSync(target, Buffer.concat([directory, entry, image]));
console.log(`wrote ${target} (${directory.length + entry.length + image.length} bytes)`);
