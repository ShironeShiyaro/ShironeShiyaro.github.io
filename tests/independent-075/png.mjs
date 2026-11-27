// Minimal dependency-free PNG decoder for the independent-075 pixel probes.
// Playwright screenshots are 8-bit, non-interlaced PNGs (RGB or RGBA), which is
// all this needs; anything else throws instead of guessing.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPng(path) {
  const buffer = readFileSync(path);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`not a PNG: ${path}`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (channels === 0 || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}): ${path}`,
    );
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const row = y * stride;
    const previous = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset];
      rawOffset += 1;
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[previous + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[previous + x - channels] : 0;
      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = (value + left) & 0xff;
          break;
        case 2:
          reconstructed = (value + up) & 0xff;
          break;
        case 3:
          reconstructed = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          reconstructed = (value + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      pixels[row + x] = reconstructed;
    }
  }
  return {
    width,
    height,
    channels,
    pixel(x, y) {
      const px = Math.max(0, Math.min(width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(height - 1, Math.round(y)));
      const index = py * stride + px * channels;
      return {
        x: px,
        y: py,
        r: pixels[index],
        g: pixels[index + 1],
        b: pixels[index + 2],
        a: channels === 4 ? pixels[index + 3] : 255,
      };
    },
  };
}

export function hex({ r, g, b }) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
