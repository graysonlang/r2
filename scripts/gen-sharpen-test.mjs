// Generates a sharpening-evaluation target into assets/sharpen_test.png — an
// opaque 8-bit RGBA image combining features that make under/over-sharpening
// obvious once downscaled:
//   - a row of black-on-white line pairs at increasing pitch (edge acutance)
//   - concentric rings (curved high-frequency edges; ringing shows as halos)
//   - a few flat mid-gray patches (sharpening must NOT add texture to flats)
//   - a soft radial gradient (over-sharpen reveals banding/overshoot)
//
//   node scripts/gen-sharpen-test.mjs [size]

import { writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';

const size = Number(process.argv[2] ?? 512);
const rgba = new Uint8Array(size * size * 4);

function set(x, y, v) {
  const i = (y * size + x) * 4;
  rgba[i] = v;
  rgba[i + 1] = v;
  rgba[i + 2] = v;
  rgba[i + 3] = 255;
}

const third = size / 3;

for (let y = 0; y < size; ++y) {
  for (let x = 0; x < size; ++x) {
    let v = 200; // default light background

    if (y < third) {
      // Top band: vertical line pairs, pitch widening left -> right.
      const pitch = 2 + ((x / (size / 10)) | 0) * 2;
      v = (x % pitch) < (pitch >> 1) ? 0 : 255;
    } else if (y < 2 * third) {
      // Middle band: concentric rings around the band center.
      const cx = size / 2;
      const cy = third * 1.5;
      const r = Math.hypot(x - cx, y - cy);
      v = (Math.floor(r / 6) % 2 === 0) ? 30 : 235;
    } else {
      // Bottom band: left half flat gray patches, right half smooth gradient.
      if (x < size / 2) {
        const patch = ((x / (size / 6)) | 0) % 2 === 0 ? 96 : 160;
        v = patch;
      } else {
        v = Math.round(((x - size / 2) / (size / 2)) * 255);
      }
    }

    set(x, y, v);
  }
}

const png = encodePng(size, size, rgba);
writeFileSync('assets/sharpen_test.png', png);
console.log(`Wrote assets/sharpen_test.png (${size}x${size}, ${png.length} bytes)`);
