// Generates alpha-handling test images (8-bit RGBA, straight alpha) into
// assets/. All transparent pixels are transparent *black* (RGB 0, A 0) so the
// difference between coverage-weighted and straight-alpha downscaling is
// visible: straight averaging pulls edge color toward that black, producing the
// classic dark fringe; coverage weighting keeps it clean.
//
//   node scripts/gen-alpha-tests.mjs [size]

import { writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';

const size = Number(process.argv[2] ?? 512);

function blank() {
  return new Uint8Array(size * size * 4); // all zero => transparent black
}

function setWhite(rgba, x, y) {
  const i = (y * size + x) * 4;
  rgba[i] = 255;
  rgba[i + 1] = 255;
  rgba[i + 2] = 255;
  rgba[i + 3] = 255;
}

// Opaque-white shapes on transparent black: discs, a ring, and thin bars/lines
// give a range of hard edges that all reveal fringing once downscaled.
function fringe() {
  const rgba = blank();
  const discR = size * 0.15;
  const discR2 = discR * discR;
  const ringOut = size * 0.15;
  const ringIn = size * 0.10;
  const ringOut2 = ringOut * ringOut;
  const ringIn2 = ringIn * ringIn;
  const discCx = size * 0.28;
  const ringCx = size * 0.72;
  const cy = size * 0.42;

  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      const dxD = x - discCx;
      const dyD = y - cy;
      const dxR = x - ringCx;
      const dyR = y - cy;
      const dDisc = dxD * dxD + dyD * dyD;
      const dRing = dxR * dxR + dyR * dyR;

      let on = dDisc < discR2 || (dRing < ringOut2 && dRing >= ringIn2);

      // Thin horizontal lines across the lower third (1px on, 7px off).
      if (y > size * 0.6 && y % 8 === 0) {
        on = true;
      }
      // Shrinking vertical bars across the lower third.
      if (y > size * 0.6) {
        const period = 6 + ((x / (size / 8)) | 0) * 4;
        if (x % period < 2) {
          on = true;
        }
      }

      if (on) {
        setWhite(rgba, x, y);
      }
    }
  }
  return rgba;
}

// Fine opaque-white / transparent-black checkerboard. Downscaled below the cell
// size it averages flat: coverage-weighted -> white at ~50% alpha; straight ->
// gray at ~50% alpha (color darkened).
function checker(cell = 6) {
  const rgba = blank();
  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      if ((((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0) {
        setWhite(rgba, x, y);
      }
    }
  }
  return rgba;
}

const images = {
  'alpha_fringe.png': fringe(),
  'alpha_checker.png': checker(),
};

for (const [name, rgba] of Object.entries(images)) {
  const png = encodePng(size, size, rgba);
  writeFileSync(`assets/${name}`, png);
  console.log(`Wrote assets/${name} (${size}x${size}, ${png.length} bytes)`);
}
