// Tolerance comparison: the C/Wasm kernel (dist-wasm/resize.mjs) vs the TS
// oracle (src/separable.ts), per spec §8 — agreement within ~1 LSB per channel,
// NOT bit-identity (double-vs-double here, but transcendental impls differ).
//
// Requires the wasm build first:  node scripts/build-wasm.mjs
// Then:                           node scripts/test-wasm.mjs

import { existsSync } from 'node:fs';
import * as esbuild from 'esbuild';

if (!existsSync('dist-wasm/resize.mjs')) {
  console.error('Missing dist-wasm/resize.mjs — run: node scripts/build-wasm.mjs');
  process.exit(1);
}

async function importTs(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', write: false,
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
  return import(url);
}

const { resizeSeparable } = await importTs('src/separable.ts');
const createModule = (await import('../dist-wasm/resize.mjs')).default;
const mod = await createModule();

// Kernel name -> C enum id (must match src/wasm/resize.c).
const KERNEL_ID = { box: 0, triangle: 1, mitchell: 2, lanczos2: 3, lanczos3: 4 };

// Run the wasm kernel: stage src bytes into the heap, call resize_rgba, read back.
function resizeWasm(src, dstW, dstH, kernel, coverage) {
  const srcBytes = src.data.length;
  const dstBytes = dstW * dstH * 4;
  const srcPtr = mod._malloc(srcBytes);
  const dstPtr = mod._malloc(dstBytes);
  try {
    mod.HEAPU8.set(src.data, srcPtr);
    const ok = mod._resize_rgba(
      srcPtr, src.width, src.height,
      dstPtr, dstW, dstH,
      KERNEL_ID[kernel], 1, 2.2, coverage ? 1 : 0,
    );
    if (!ok) {
      throw new Error('resize_rgba returned 0');
    }
    return new Uint8ClampedArray(mod.HEAPU8.subarray(dstPtr, dstPtr + dstBytes));
  } finally {
    mod._free(srcPtr);
    mod._free(dstPtr);
  }
}

// Pool-style: resize_init then resize_tile over a tile grid, blitting each tile
// into the destination. Should be bit-identical to resize_rgba (same build).
function resizeWasmTiled(src, dstW, dstH, kernel, coverage, tile) {
  const srcBytes = src.data.length;
  const srcPtr = mod._malloc(srcBytes);
  mod.HEAPU8.set(src.data, srcPtr);
  const ctx = mod._resize_init(srcPtr, src.width, src.height, dstW, dstH,
    KERNEL_ID[kernel], 1, 2.2, coverage ? 1 : 0);
  mod._free(srcPtr); // init copied what it needs into its own buffers
  if (!ctx) {
    throw new Error('resize_init returned 0');
  }
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  try {
    for (let oy0 = 0; oy0 < dstH; oy0 += tile) {
      const oy1 = Math.min(oy0 + tile, dstH);
      for (let ox0 = 0; ox0 < dstW; ox0 += tile) {
        const ox1 = Math.min(ox0 + tile, dstW);
        const tw = ox1 - ox0;
        const th = oy1 - oy0;
        const tp = mod._malloc(tw * th * 4);
        try {
          if (!mod._resize_tile(ctx, ox0, oy0, ox1, oy1, tp)) {
            throw new Error('resize_tile returned 0');
          }
          const tilePixels = mod.HEAPU8.subarray(tp, tp + tw * th * 4);
          for (let y = 0; y < th; ++y) {
            const sRow = y * tw * 4;
            const dRow = ((oy0 + y) * dstW + ox0) * 4;
            out.set(tilePixels.subarray(sRow, sRow + tw * 4), dRow);
          }
        } finally {
          mod._free(tp);
        }
      }
    }
  } finally {
    mod._resize_free(ctx);
  }
  return out;
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width: w, height: h };
}

// A varied opaque-and-alpha image; several scales and all kernels.
const SRC_W = 64;
const SRC_H = 48;
const img = makeImage(SRC_W, SRC_H, (x, y) => {
  const r = (x * 7 + y * 3) & 255;
  const g = (x * 2 + y * 11) & 255;
  const b = ((x ^ y) * 5) & 255;
  const a = (x + y) % 5 === 0 ? ((x * 9) & 255) : 255;
  return [r, g, b, a];
});

const TOLERANCE = 1; // max abs channel diff allowed (LSB)
const dstSizes = [[32, 24], [21, 17], [48, 9]];

for (const kernel of ['box', 'triangle', 'mitchell', 'lanczos2', 'lanczos3']) {
  for (const coverage of [true, false]) {
    for (const [dw, dh] of dstSizes) {
      const ts = resizeSeparable(img, dw, dh, { kernel, coverageWeightedAlpha: coverage });
      const wasm = resizeWasm(img, dw, dh, kernel, coverage);

      let maxDiff = 0;
      let at = -1;
      for (let i = 0; i < ts.length; ++i) {
        const d = Math.abs(ts[i] - wasm[i]);
        if (d > maxDiff) {
          maxDiff = d;
          at = i;
        }
      }
      check(
        `[${kernel}${coverage ? '' : ',straight'}] ${dw}x${dh}: wasm ~ TS oracle (<=${TOLERANCE} LSB)`,
        maxDiff <= TOLERANCE,
        `maxDiff=${maxDiff}${maxDiff > TOLERANCE ? ` @${at}` : ''}`,
      );
    }
  }
}

// --- Tile API (resize_init/resize_tile) == whole-image (resize_rgba) ---------
// The Wasm pool path computes tiles via resize_init + resize_tile; this must be
// bit-identical to the whole-image resize_rgba in the same build.
for (const kernel of ['box', 'mitchell', 'lanczos2', 'lanczos3']) {
  for (const coverage of [true, false]) {
    for (const [dw, dh] of dstSizes) {
      const whole = resizeWasm(img, dw, dh, kernel, coverage);
      for (const tile of [4, 8, Math.max(dw, dh)]) {
        const tiled = resizeWasmTiled(img, dw, dh, kernel, coverage, tile);
        let identical = whole.length === tiled.length;
        let at = -1;
        for (let i = 0; identical && i < whole.length; ++i) {
          if (whole[i] !== tiled[i]) {
            identical = false;
            at = i;
          }
        }
        check(`[${kernel}${coverage ? '' : ',straight'}] ${dw}x${dh} tile ${tile}: resize_tile == resize_rgba`,
          identical, at >= 0 ? `first diff @${at}` : '');
      }
    }
  }
}

// --- Throughput signal (Wasm vs TS oracle) --------------------------------
// Not a pass/fail check — a rough per-call timing so the SIMD optimization has a
// visible signal. Uses a larger image at the default kernel; warms up first.
const PERF_W = 2048;
const PERF_H = 2048;
const perfImg = makeImage(PERF_W, PERF_H, (x, y) => [(x ^ y) & 255, (x * 3) & 255, (y * 3) & 255, 255]);
const perfDstW = Math.floor(PERF_W * 0.65);
const perfDstH = Math.floor(PERF_H * 0.65);
const perfKernel = 'lanczos2';

function timeIt(fn, iters) {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < iters; ++i) {
    fn();
  }
  return (performance.now() - t0) / iters;
}

const iters = 5;
const tsMs = timeIt(() => resizeSeparable(perfImg, perfDstW, perfDstH, { kernel: perfKernel }), iters);
const wasmMs = timeIt(() => resizeWasm(perfImg, perfDstW, perfDstH, perfKernel, true), iters);
const mpix = (perfDstW * perfDstH) / 1e6;
console.log(`\nThroughput (${PERF_W}x${PERF_H} -> ${perfDstW}x${perfDstH}, ${perfKernel}, avg of ${iters}):`);
console.log(`  TS   ${tsMs.toFixed(1)}ms  (${(mpix / (tsMs / 1000)).toFixed(1)} Mpix/s)`);
console.log(`  Wasm ${wasmMs.toFixed(1)}ms  (${(mpix / (wasmMs / 1000)).toFixed(1)} Mpix/s)  ${(tsMs / wasmMs).toFixed(2)}x vs TS`);

console.log(failures === 0 ? '\nAll wasm tolerance checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
