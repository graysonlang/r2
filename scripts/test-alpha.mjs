// Verifies the resampler's alpha handling against tiled-scaler-spec.md §9.1:
//   - alpha fringe: coverage-weighting keeps edge color clean; straight averaging
//     darkens it (and the test detects that difference)
//   - degenerate region: fully transparent input -> transparent black, no NaN
//   - opaque passthrough: coverage vs straight agree on fully opaque pixels
//
// Builds src/resize.ts in-memory with esbuild and imports it; run with:
//   node scripts/test-alpha.mjs

import * as esbuild from 'esbuild';

async function importTs(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
  return import(url);
}

const { resize, ResizeOptions } = await importTs('src/resize.ts');
const {
  resizeSeparable,
  resizeSeparableTiled,
  resizeThumbnail,
  prepareTiling,
  resizeTileRegion,
} = await importTs('src/separable.ts');

let failures = 0;
function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height };
}

function px(out, width, x, y) {
  const i = (y * width + x) * 4;
  return { r: out[i], g: out[i + 1], b: out[i + 2], a: out[i + 3] };
}

function withCoverage(flag) {
  const o = new ResizeOptions();
  o.coverageWeightedAlpha = flag;
  return o;
}

// Left half opaque white, right half transparent black. 8->3 forces the middle
// output column to straddle the boundary (partial coverage).
const SRC = 8;
const DST = 3;
const split = makeImage(SRC, SRC, x =>
  x < SRC / 2 ? [255, 255, 255, 255] : [0, 0, 0, 0],
);

const cov = resize(split, DST, DST, withCoverage(true));
const straight = resize(split, DST, DST, withCoverage(false));

const covEdge = px(cov, DST, 1, 1);
const strEdge = px(straight, DST, 1, 1);
const covOpaque = px(cov, DST, 0, 1);
const covClear = px(cov, DST, 2, 1);

// Coverage-weighted: edge keeps full white; straight averaging darkens it.
check('coverage keeps edge color white', covEdge.r >= 254, `r=${covEdge.r}`);
check('straight averaging darkens edge', strEdge.r < 230, `r=${strEdge.r}`);
check(
  'edge is genuinely partial coverage',
  covEdge.a > 0 && covEdge.a < 255,
  `a=${covEdge.a}`,
);
check(
  'alpha identical between modes (alpha is plain coverage)',
  covEdge.a === strEdge.a,
  `${covEdge.a} vs ${strEdge.a}`,
);
check('opaque region stays opaque white', covOpaque.r === 255 && covOpaque.a === 255);
check('transparent region stays transparent black',
  covClear.r === 0 && covClear.a === 0);

// Degenerate: fully transparent input -> all transparent black, no NaN/Inf.
const clear = makeImage(SRC, SRC, () => [0, 0, 0, 0]);
const clearOut = resize(clear, DST, DST, withCoverage(true));
let degenerateOk = true;
for (let i = 0; i < clearOut.length; ++i) {
  if (clearOut[i] !== 0 || Number.isNaN(clearOut[i])) {
    degenerateOk = false;
    break;
  }
}
check('fully transparent input -> transparent black', degenerateOk);

// Fully opaque input: coverage and straight must agree exactly.
const opaque = makeImage(SRC, SRC, (x, y) => [(x * 32) & 255, (y * 32) & 255, 128, 255]);
const oCov = resize(opaque, DST, DST, withCoverage(true));
const oStr = resize(opaque, DST, DST, withCoverage(false));
let opaqueAgree = oCov.length === oStr.length;
for (let i = 0; opaqueAgree && i < oCov.length; ++i) {
  if (oCov[i] !== oStr[i]) {
    opaqueAgree = false;
  }
}
check('opaque image: coverage == straight', opaqueAgree);

// Edge policy (spec §5.5): out-of-bounds must be excluded from BOTH denominators
// (weight 0), not modeled as transparent-black samples. The observable contract:
// a fully-opaque image must stay fully opaque at every border pixel after a
// downscale — no perimeter alpha falloff. The box resampler achieves this by
// never sampling out of bounds; this guards it (and the future wide kernel)
// against a "zero-alpha outside" regression that would dim the edges.
const opaqueFlat = makeImage(SRC, SRC, () => [200, 120, 60, 255]);
const edgeOut = resize(opaqueFlat, DST, DST, withCoverage(true));
let edgesOpaque = true;
for (let ex = 0; ex < DST; ++ex) {
  if (px(edgeOut, DST, ex, 0).a !== 255 || px(edgeOut, DST, ex, DST - 1).a !== 255) {
    edgesOpaque = false;
  }
}
for (let ey = 0; ey < DST; ++ey) {
  if (px(edgeOut, DST, 0, ey).a !== 255 || px(edgeOut, DST, DST - 1, ey).a !== 255) {
    edgesOpaque = false;
  }
}
check('opaque image stays opaque at all borders (no OOB falloff)', edgesOpaque);

// Sharpening (spec §5.6). Coefficient 0 must be byte-identical to the no-sharpen
// path (identity), and a sharpen pass must not reintroduce alpha fringing on the
// transparent-black edge — the coverage-correct domain keeps edge color clean.
function withSharpen(coverage, coeff) {
  const o = new ResizeOptions();
  o.coverageWeightedAlpha = coverage;
  o.sharpeningCoefficient = coeff;
  return o;
}

const sharp0 = resize(opaque, DST, DST, withSharpen(true, 0));
let identity = sharp0.length === oCov.length;
for (let i = 0; identity && i < oCov.length; ++i) {
  if (sharp0[i] !== oCov[i]) {
    identity = false;
  }
}
check('sharpen coefficient 0 == no-sharpen path', identity);

// Sharpen a larger split (more interior so sharpening has neighbors to act on);
// the opaque-side edge must not be dragged dark by the transparent region.
const bigSplit = makeImage(16, 16, x => (x < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
const sharpCov = resize(bigSplit, 6, 6, withSharpen(true, 0.5));
let noFringe = true;
let sample = -1;
for (let ey = 0; ey < 6; ++ey) {
  // Column 1 is fully inside the opaque half -> must stay clean white.
  const p = px(sharpCov, 6, 1, ey);
  if (p.a === 255 && p.r < 250) {
    noFringe = false;
    sample = p.r;
  }
}
check('sharpen keeps opaque-side color clean (no dark fringe)', noFringe,
  sample >= 0 ? `r=${sample}` : '');

// Sharpen must not produce NaN/Inf anywhere on an alpha image.
let finite = true;
for (let i = 0; i < sharpCov.length; ++i) {
  if (!Number.isFinite(sharpCov[i])) {
    finite = false;
    break;
  }
}
check('sharpen output is finite (no NaN/Inf)', finite);

// --- Separable resampler (src/separable.ts) -------------------------------
// Same alpha/edge contracts must hold across every kernel.

for (const kernel of ['box', 'triangle', 'mitchell', 'lanczos2', 'lanczos3']) {
  const sep = (img, w, h, coverage = true) =>
    resizeSeparable(img, w, h, { kernel, coverageWeightedAlpha: coverage });

  // Coverage keeps the opaque-side edge clean (no dark fringe) on the split.
  const covE = px(sep(split, DST, DST, true), DST, 1, 1);
  const strE = px(sep(split, DST, DST, false), DST, 1, 1);
  check(`[${kernel}] coverage edge brighter than straight`, covE.r > strE.r,
    `cov=${covE.r} str=${strE.r}`);

  // Fully transparent input -> transparent black, no NaN/Inf.
  const clr = sep(clear, DST, DST);
  let clrOk = true;
  for (let i = 0; i < clr.length; ++i) {
    if (clr[i] !== 0 || !Number.isFinite(clr[i])) {
      clrOk = false;
      break;
    }
  }
  check(`[${kernel}] transparent input -> transparent black`, clrOk);

  // Opaque image stays opaque at all borders (edge policy: no OOB falloff).
  const eo = sep(opaqueFlat, DST, DST);
  let edges = true;
  for (let e = 0; e < DST; ++e) {
    if (px(eo, DST, e, 0).a !== 255 || px(eo, DST, e, DST - 1).a !== 255
      || px(eo, DST, 0, e).a !== 255 || px(eo, DST, DST - 1, e).a !== 255) {
      edges = false;
    }
  }
  check(`[${kernel}] opaque stays opaque at borders`, edges);

  // Output is finite everywhere (Mitchell/Lanczos overshoot but must clamp).
  const oo = sep(opaque, DST, DST);
  let fin = true;
  for (let i = 0; i < oo.length; ++i) {
    if (!Number.isFinite(oo[i])) {
      fin = false;
      break;
    }
  }
  check(`[${kernel}] output finite (lobes clamp, no NaN/Inf)`, fin);
}

// The separable box should track the fused-box oracle closely on a smooth opaque
// image (not bit-identical — different boundary model — but within a few LSB).
const sepBox = resizeSeparable(opaque, DST, DST, { kernel: 'box' });
let maxDiff = 0;
for (let i = 0; i < sepBox.length; ++i) {
  maxDiff = Math.max(maxDiff, Math.abs(sepBox[i] - oCov[i]));
}
check('separable box ~ fused box oracle (<=8 LSB)', maxDiff <= 8, `maxDiff=${maxDiff}`);

// --- Tiled == whole-image bit-identity (spec §9.1, the key Phase-3 checkpoint) -
// The tiled path must produce byte-for-byte the same output as the whole-image
// oracle, for every kernel and a range of tile sizes (including ones that don't
// divide the output evenly, single-row/col tiles, and tiles larger than the
// image). A varied RGBA image with a hard alpha edge exercises the apron.
const TILE_SRC_W = 37;
const TILE_SRC_H = 29;
const tileImage = makeImage(TILE_SRC_W, TILE_SRC_H, (x, y) => {
  // High-frequency color + a diagonal hard alpha cutout to stress edges/coverage.
  const r = (x * 17 + y * 5) & 255;
  const g = (x * 3 + y * 23) & 255;
  const b = ((x ^ y) * 9) & 255;
  const a = (x + y) % 7 === 0 ? 0 : (x * 8) & 255;
  return [r, g, b, a];
});
const TILE_DST_W = 19;
const TILE_DST_H = 13;
const tileSizes = [[1, 1], [4, 4], [8, 3], [TILE_DST_W, 1], [1, TILE_DST_H], [64, 64]];

for (const kernel of ['box', 'triangle', 'mitchell', 'lanczos2', 'lanczos3']) {
  for (const coverage of [true, false]) {
    const whole = resizeSeparable(tileImage, TILE_DST_W, TILE_DST_H, {
      kernel, coverageWeightedAlpha: coverage,
    });
    for (const [tw, th] of tileSizes) {
      const tiled = resizeSeparableTiled(tileImage, TILE_DST_W, TILE_DST_H, tw, th, {
        kernel, coverageWeightedAlpha: coverage,
      });
      let identical = whole.length === tiled.length;
      let at = -1;
      for (let i = 0; identical && i < whole.length; ++i) {
        if (whole[i] !== tiled[i]) {
          identical = false;
          at = i;
        }
      }
      check(`[${kernel}${coverage ? '' : ',straight'}] tiled ${tw}x${th} == whole-image`,
        identical, at >= 0 ? `first diff @${at}` : '');
    }
  }
}

// --- Pool reassembly: prepareTiling + resizeTileRegion + blit == whole-image ---
// The worker pool computes each tile via resizeTileRegion (a tile-local buffer)
// and blits it into the destination. This reproduces that reassembly on the main
// thread (no workers) and checks it's bit-identical to the whole-image oracle —
// the correctness the pool rests on; the Worker layer only moves these buffers.
function reassembleViaTiles(img, dw, dh, tw, th, opts) {
  const plan = prepareTiling(img, dw, dh, tw, th, opts);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (const rect of plan.tiles) {
    const tile = resizeTileRegion(plan, rect);
    const tileW = rect.ox1 - rect.ox0;
    for (let y = rect.oy0; y < rect.oy1; ++y) {
      const sRow = (y - rect.oy0) * tileW * 4;
      const dRow = (y * dw + rect.ox0) * 4;
      out.set(tile.subarray(sRow, sRow + tileW * 4), dRow);
    }
  }
  return out;
}

for (const kernel of ['box', 'mitchell', 'lanczos2']) {
  for (const coverage of [true, false]) {
    const whole = resizeSeparable(tileImage, TILE_DST_W, TILE_DST_H, {
      kernel, coverageWeightedAlpha: coverage,
    });
    for (const [tw, th] of [[8, 8], [5, 5], [TILE_DST_W, TILE_DST_H]]) {
      const pooled = reassembleViaTiles(tileImage, TILE_DST_W, TILE_DST_H, tw, th, {
        kernel, coverageWeightedAlpha: coverage,
      });
      let identical = whole.length === pooled.length;
      for (let i = 0; identical && i < whole.length; ++i) {
        if (whole[i] !== pooled[i]) {
          identical = false;
        }
      }
      check(`[${kernel}${coverage ? '' : ',straight'}] pool tiles ${tw}x${th} reassemble == whole-image`,
        identical);
    }
  }
}

// --- Shrink-then-reduce (resizeThumbnail) -----------------------------------
// Not bit-identical to pure Lanczos (box pre-filter + 8-bit intermediate), but
// should be CLOSE on a smooth image, exact-fallback when no pre-shrink applies,
// and never produce NaN / wrong alpha on a hard alpha edge.
const thumbSrc = makeImage(400, 300, (x, y) => {
  // Smooth-ish gradient + mild structure so box vs Lanczos differ only slightly.
  const r = (x * 0.6) & 255;
  const g = (y * 0.85) & 255;
  const b = ((x + y) * 0.4) & 255;
  const a = (x % 40 < 4) ? 64 : 255; // some partial-alpha columns
  return [r, g, b, a];
});

// Fallback: <2x downscale → identical to resizeSeparable (no pre-shrink).
const tnFallback = resizeThumbnail(thumbSrc, 300, 225, { kernel: 'lanczos2' });
const tnPlain = resizeSeparable(thumbSrc, 300, 225, { kernel: 'lanczos2' });
let fbIdentical = tnFallback.length === tnPlain.length;
for (let i = 0; fbIdentical && i < tnPlain.length; ++i) {
  if (tnFallback[i] !== tnPlain[i]) {
    fbIdentical = false;
  }
}
check('thumbnail <2x downscale falls back to plain (identical)', fbIdentical);

// Thumbnail ratio (400x300 -> 50x38, ~8x): close to pure Lanczos, finite, alpha sane.
const TW = 50, TH = 38;
const tn = resizeThumbnail(thumbSrc, TW, TH, { kernel: 'lanczos2' });
const pure = resizeSeparable(thumbSrc, TW, TH, { kernel: 'lanczos2' });
let maxD = 0;
for (let i = 0; i < tn.length; ++i) {
  maxD = Math.max(maxD, Math.abs(tn[i] - pure[i]));
}
check('thumbnail correct length', tn.length === TW * TH * 4);
// "Close" = within a generous threshold; box+Lanczos is a different filter, so
// this is a sanity bound (no gross divergence), not a tight tolerance.
check('thumbnail ~ pure Lanczos (max channel diff <= 40)', maxD <= 40, `maxDiff=${maxD}`);

// Degenerate: fully transparent thumbnail stays transparent black.
const clearBig = makeImage(400, 300, () => [0, 0, 0, 0]);
const tnClear = resizeThumbnail(clearBig, TW, TH, { kernel: 'lanczos2' });
let clearOk = true;
for (let i = 0; i < tnClear.length; ++i) {
  if (tnClear[i] !== 0) {
    clearOk = false;
    break;
  }
}
check('thumbnail of transparent input -> transparent black', clearOk);

console.log(failures === 0 ? '\nAll alpha checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
