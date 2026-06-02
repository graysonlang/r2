// Apples-to-apples resampler race: our TS kernel vs libvips (via sharp), in
// Node. Isolates the RESAMPLER — raw RGBA buffer in, raw RGBA buffer out, no
// file decode/encode — same kernel, linear-light on both sides, single-threaded
// then matched N-threaded.
//
//   node scripts/bench-vips.mjs
//
// Caveat: this is a Node measurement (sharp is native Node; our kernel normally
// runs in browser workers). It sizes up the kernel/algorithm gap, not the browser
// deployment. Fairness notes inline.

import * as esbuild from 'esbuild';
import sharp from 'sharp';

async function importTs(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', write: false,
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
  return import(url);
}

const { resizeSeparable, resizeThumbnail } = await importTs('src/separable.ts');

const W = 4096, H = 4096, SCALE = 0.65, KERNEL = 'lanczos2';
const dw = Math.floor(W * SCALE), dh = Math.floor(H * SCALE);
const WARMUP = 2, RUNS = 6;

// One shared source: opaque RGBA noise (alpha 255 so coverage math is a no-op,
// keeping the kernels comparable — libvips premultiplies only when asked).
const src = Buffer.alloc(W * H * 4);
for (let i = 0; i < src.length; i += 4) {
  src[i] = (i * 7) & 255;
  src[i + 1] = (i * 13) & 255;
  src[i + 2] = (i * 5) & 255;
  src[i + 3] = 255;
}
const srcU8 = new Uint8ClampedArray(src.buffer, src.byteOffset, src.length);
const img = { data: srcU8, width: W, height: H };

async function timeAsync(fn, runs) {
  for (let i = 0; i < WARMUP; ++i) await fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; ++i) await fn();
  return (performance.now() - t0) / runs;
}
function timeSync(fn, runs) {
  for (let i = 0; i < WARMUP; ++i) fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; ++i) fn();
  return (performance.now() - t0) / runs;
}

// --- ours: TS (single-threaded kernel) ---
const tsMs = timeSync(() => resizeSeparable(img, dw, dh, { kernel: KERNEL }), RUNS);

// --- libvips (sharp): raw RGBA in/out, same kernel, linear-light, N threads ---
// .gamma() makes libvips resize in linear light (its default is non-linear sRGB),
// matching our pipeline — this is the fair, more-work setting.
function vipsResize() {
  return sharp(src, { raw: { width: W, height: H, channels: 4 } })
    .gamma() // linearize before resize, de-linearize after
    .resize(dw, dh, { kernel: KERNEL, fit: 'fill' })
    .raw()
    .toBuffer();
}

async function vipsAt(concurrency) {
  sharp.concurrency(concurrency);
  return timeAsync(vipsResize, RUNS);
}

const vips1 = await vipsAt(1);
const cores = (await import('node:os')).cpus().length;
const vipsN = await vipsAt(cores);

const mpx = (dw * dh) / 1e6;
const rate = ms => (mpx / (ms / 1e3)).toFixed(0);
console.log(`# ${W}² → ${dw}×${dh}, kernel ${KERNEL}, linear-light, raw RGBA in/out`);
console.log(`# avg of ${RUNS} (drop ${WARMUP}); cores=${cores}; libvips ${sharp.versions.vips}\n`);
console.log(`ours TS   (1 thread)   ${tsMs.toFixed(1)}ms   ${rate(tsMs)} Mpix/s`);
console.log(`libvips   (1 thread)   ${vips1.toFixed(1)}ms   ${rate(vips1)} Mpix/s`);
console.log(`libvips   (${cores} threads)  ${vipsN.toFixed(1)}ms   ${rate(vipsN)} Mpix/s`);
console.log(`\n# single-thread: libvips is ${(tsMs / vips1).toFixed(1)}x our TS`);

// --- Thumbnail regime: large downscale, where shrink-then-reduce pays off ---
const TW = 256, TH = 256;
const tmpx = (TW * TH) / 1e6;
const trate = ms => (tmpx / (ms / 1e3)).toFixed(0);
const tnPlain = timeSync(() => resizeSeparable(img, TW, TH, { kernel: KERNEL }), RUNS);
const tnShrink = timeSync(() => resizeThumbnail(img, TW, TH, { kernel: KERNEL }), RUNS);
function vipsThumb() {
  return sharp(src, { raw: { width: W, height: H, channels: 4 } })
    .gamma().resize(TW, TH, { kernel: KERNEL, fit: 'fill' }).raw().toBuffer();
}
sharp.concurrency(1);
const vipsT1 = await timeAsync(vipsThumb, RUNS);
console.log(`\n# thumbnail ${W}² → ${TW}×${TH} (${(W / TW).toFixed(0)}x downscale)`);
console.log(`ours TS pure-Lanczos   ${tnPlain.toFixed(1)}ms   ${trate(tnPlain)} Mpix/s`);
console.log(`ours TS shrink-reduce  ${tnShrink.toFixed(1)}ms   ${trate(tnShrink)} Mpix/s   ${(tnPlain / tnShrink).toFixed(1)}x faster than pure`);
console.log(`libvips (1 thread)     ${vipsT1.toFixed(1)}ms   ${trate(vipsT1)} Mpix/s`);
console.log(`# shrink-reduce closes the libvips gap to ${(tnShrink / vipsT1).toFixed(1)}x (was ${(tnPlain / vipsT1).toFixed(1)}x pure)`);
