// Generates a circular zone-plate test image — a radially increasing spatial
// frequency that makes resampling aliasing immediately visible. Writes an 8-bit
// RGBA grayscale PNG to assets/zone_plate.png.
//
//   node scripts/gen-zone-plate.mjs [size]

import { writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';

const size = Number(process.argv[2] ?? 512);

const rgba = new Uint8Array(size * size * 4);
const center = (size - 1) / 2;
const k = (Math.PI * 0.5) / size;
let p = 0;
for (let y = 0; y < size; ++y) {
  const dy = y - center;
  for (let x = 0; x < size; ++x) {
    const dx = x - center;
    const g = 0.5 + 0.5 * Math.cos(k * (dx * dx + dy * dy));
    const v = Math.round(g * 255);
    rgba[p++] = v;
    rgba[p++] = v;
    rgba[p++] = v;
    rgba[p++] = 255;
  }
}

const png = encodePng(size, size, rgba);
writeFileSync('assets/zone_plate.png', png);
console.log(`Wrote assets/zone_plate.png (${size}x${size}, ${png.length} bytes)`);
