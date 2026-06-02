// Separable, filtered image downscaler — the general form that supports box,
// triangle, Mitchell, and Lanczos kernels behind one code path.
//
// This is the structure the spec (tiled-scaler-spec.md §5.1) assumes for Phase 3
// and the eventual Wasm/SIMD kernel. It is a clean-room companion to the fused
// area resampler in resize.ts (which stays the oracle); this module exists to
// A/B filter quality and to be the SIMD-friendly base later. Differences from
// the fused box:
//   - Two explicit 1D passes (horizontal then vertical), linear f32 throughout.
//   - A precomputed per-axis weight table; the kernel only changes the weights,
//     not the loop. Output pixels are independent (no carry-over) — which is what
//     makes it tileable AND vectorizable (see docs/resampling.md).
//   - Filters with negative lobes (Mitchell, Lanczos) can overshoot [0,1]; that
//     is expected and clamps on encode.
//
// Alpha handling matches resize.ts / spec §5.4: coverage-weighted (premultiply
// at ingest, filter premultiplied through both passes, un-premultiply on output).
//
// Edge policy (spec §5.5): out-of-bounds taps are given weight 0 and the
// in-bounds weights are renormalized to sum to 1 — NOT modeled as transparent
// black. This keeps an opaque image opaque to the border (the Photoshop
// PNG-frame bug we explicitly avoid). Because weights are normalized per output,
// no separate Σw division is needed downstream.
//
// Scope: 8-bit RGBA, interleaved, downscale only.

const COMPONENTS = 4;

// Coverage at/below this is treated as fully transparent (numerical floor for the
// un-premultiply divide, not a perceptual cutoff).
const ALPHA_EPSILON = 1e-6;

const SRGB_GAMMA = 2.4;

export type KernelName = 'box' | 'triangle' | 'mitchell' | 'lanczos2' | 'lanczos3';

interface Kernel {
  /** Support radius in output-normalized units (taps reach |x| <= radius). */
  readonly radius: number;
  /** Filter weight at normalized offset x from the sample center. */
  weight(x: number): number;
}

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function lanczos(a: number): Kernel {
  return {
    radius: a,
    weight(x: number): number {
      const ax = Math.abs(x);
      return ax < a ? sinc(x) * sinc(x / a) : 0;
    },
  };
}

// Mitchell-Netravali with B = C = 1/3 (the classic balanced default).
const MITCHELL_B = 1 / 3;
const MITCHELL_C = 1 / 3;

const KERNELS: Record<KernelName, Kernel> = {
  // Radius 0.5 box; stretched by the scale factor below it becomes area-average.
  box: { radius: 0.5, weight: x => (Math.abs(x) < 0.5 ? 1 : 0) },
  triangle: { radius: 1, weight: x => Math.max(0, 1 - Math.abs(x)) },
  mitchell: {
    radius: 2,
    weight(x: number): number {
      const ax = Math.abs(x);
      const ax2 = ax * ax;
      const ax3 = ax2 * ax;
      if (ax < 1) {
        return ((12 - 9 * MITCHELL_B - 6 * MITCHELL_C) * ax3
          + (-18 + 12 * MITCHELL_B + 6 * MITCHELL_C) * ax2
          + (6 - 2 * MITCHELL_B)) / 6;
      }
      if (ax < 2) {
        return ((-MITCHELL_B - 6 * MITCHELL_C) * ax3
          + (6 * MITCHELL_B + 30 * MITCHELL_C) * ax2
          + (-12 * MITCHELL_B - 48 * MITCHELL_C) * ax
          + (8 * MITCHELL_B + 24 * MITCHELL_C)) / 6;
      }
      return 0;
    },
  },
  lanczos2: lanczos(2),
  lanczos3: lanczos(3),
};

export interface SeparableOptions {
  kernel: KernelName;
  /** Use the sRGB piecewise transfer function. When false, use `gamma`. */
  sRGBGamma: boolean;
  /** Pure-power gamma exponent, used only when `sRGBGamma` is false. */
  gamma: number;
  /** Alpha-weight color (premultiply) so transparent pixels contribute no color. */
  coverageWeightedAlpha: boolean;
}

export function createSeparableOptions(overrides: Partial<SeparableOptions> = {}): SeparableOptions {
  return {
    kernel: 'mitchell',
    sRGBGamma: true,
    gamma: 2.2,
    coverageWeightedAlpha: true,
    ...overrides,
  };
}

// Precomputed taps for one axis: each output index reads `count` source samples
// starting at `start`, with normalized `weight` values (flat, indexed by offset).
interface AxisWeights {
  readonly start: Int32Array;
  readonly count: Int32Array;
  readonly offset: Int32Array;
  readonly weight: Float64Array;
}

// Build the per-output tap table mapping `srcN` source samples to `dstN` outputs.
// Downscaling stretches the kernel (filterScale = scale) so support widens to
// average more source samples; out-of-bounds taps are dropped and the remainder
// renormalized to sum to 1 (edge policy above).
function buildAxisWeights(srcN: number, dstN: number, kernel: Kernel): AxisWeights {
  const scale = dstN / srcN;
  const filterScale = scale < 1 ? scale : 1;
  const support = kernel.radius / filterScale;

  const start = new Int32Array(dstN);
  const count = new Int32Array(dstN);
  const offset = new Int32Array(dstN);
  const flat: number[] = [];

  for (let o = 0; o < dstN; ++o) {
    const center = (o + 0.5) / scale - 0.5;
    const left = Math.max(0, Math.ceil(center - support));
    const right = Math.min(srcN - 1, Math.floor(center + support));

    let sum = 0;
    const local: number[] = [];
    for (let i = left; i <= right; ++i) {
      const w = kernel.weight((i - center) * filterScale);
      local.push(w);
      sum += w;
    }
    // Renormalize over the in-bounds taps so weights sum to 1.
    const inv = sum !== 0 ? 1 / sum : 0;

    start[o] = left;
    count[o] = local.length;
    offset[o] = flat.length;
    for (const w of local) {
      flat.push(w * inv);
    }
  }

  return { start, count, offset, weight: Float64Array.from(flat) };
}

function buildDecodeLut(sRGBGamma: boolean, gamma: number): Float64Array {
  const lut = new Float64Array(256);
  if (sRGBGamma) {
    for (let i = 0; i < 256; ++i) {
      const c = i / 255;
      lut[i] = c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, SRGB_GAMMA);
    }
  } else {
    for (let i = 0; i < 256; ++i) {
      lut[i] = Math.pow(i / 255, gamma);
    }
  }
  return lut;
}

function makeEncode(sRGBGamma: boolean, gamma: number): (c: number) => number {
  const invGamma = 1 / gamma;
  if (sRGBGamma) {
    return (c: number): number => {
      if (c <= 0) {
        return 0;
      }
      if (c >= 1) {
        return 255;
      }
      const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / SRGB_GAMMA) - 0.055;
      return Math.round(s * 255);
    };
  }
  return (c: number): number => {
    if (c <= 0) {
      return 0;
    }
    if (c >= 1) {
      return 255;
    }
    return Math.round(Math.pow(c, invGamma) * 255);
  };
}

/** Minimal source shape: an `ImageData`, or anything with the same fields. */
export interface ResizeSource {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

type DecodeLut = Float64Array;
type Encode = (c: number) => number;

// Horizontal pass over a rectangular region: resample input rows [iy0, iy1) and
// output columns [ox0, ox1) into `inter`, laid out as (iy1-iy0) rows of
// (ox1-ox0)*COMPONENTS — i.e. local to the region, with row base iy0 and column
// base ox0. Carries linear, premultiplied-when-coverage RGB plus linear coverage
// in the 4th channel. Reads global source bytes via the global weight table, so
// the result at any (y, ox) is independent of how the region was chosen.
function horizontalPass(
  srcData: Uint8ClampedArray,
  srcWidth: number,
  xw: AxisWeights,
  decode: DecodeLut,
  useCoverage: boolean,
  iy0: number,
  iy1: number,
  ox0: number,
  ox1: number,
  inter: Float64Array,
): void {
  const interStride = (ox1 - ox0) * COMPONENTS;
  for (let y = iy0; y < iy1; ++y) {
    const srcRow = y * srcWidth * COMPONENTS;
    const interRow = (y - iy0) * interStride;
    for (let ox = ox0; ox < ox1; ++ox) {
      const start = xw.start[ox];
      const count = xw.count[ox];
      const woff = xw.offset[ox];

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (let t = 0; t < count; ++t) {
        const w = xw.weight[woff + t];
        const p = srcRow + (start + t) * COMPONENTS;
        const a = srcData[p + 3] / 255;
        const cw = useCoverage ? a : 1;
        r += w * decode[srcData[p]] * cw;
        g += w * decode[srcData[p + 1]] * cw;
        b += w * decode[srcData[p + 2]] * cw;
        alpha += w * a;
      }

      const o = interRow + (ox - ox0) * COMPONENTS;
      inter[o] = r;
      inter[o + 1] = g;
      inter[o + 2] = b;
      inter[o + 3] = alpha;
    }
  }
}

// Vertical pass over a rectangular region: resample output rows [oy0, oy1) and
// columns [ox0, ox1) from `inter` (whose rows are based at `interRowBase` and
// columns at ox0, width `interTileW`), then un-premultiply and encode into `dst`.
//
// `dst` is addressed as `dstRowWidth` pixels per row with the region's top-left
// at (dstOx0, dstOy0): pass (dstWidth, 0, 0) to write into the full destination
// (whole-image / shared-tiling), or (tileW, ox0, oy0) to write a tile-local
// buffer. The accumulation arithmetic is identical either way, so tile-local
// output is bit-identical to the shared-destination path.
function verticalPass(
  inter: Float64Array,
  interRowBase: number,
  interTileW: number,
  yw: AxisWeights,
  encode: Encode,
  useCoverage: boolean,
  oy0: number,
  oy1: number,
  ox0: number,
  ox1: number,
  dst: Uint8ClampedArray,
  dstRowWidth: number,
  dstOx0 = 0,
  dstOy0 = 0,
): void {
  const interStride = interTileW * COMPONENTS;
  const dstStride = dstRowWidth * COMPONENTS;
  for (let oy = oy0; oy < oy1; ++oy) {
    const start = yw.start[oy];
    const count = yw.count[oy];
    const woff = yw.offset[oy];
    const dstRow = (oy - dstOy0) * dstStride;

    for (let ox = ox0; ox < ox1; ++ox) {
      const col = (ox - ox0) * COMPONENTS;
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (let t = 0; t < count; ++t) {
        const w = yw.weight[woff + t];
        const p = (start + t - interRowBase) * interStride + col;
        r += w * inter[p];
        g += w * inter[p + 1];
        b += w * inter[p + 2];
        alpha += w * inter[p + 3];
      }

      const o = dstRow + (ox - dstOx0) * COMPONENTS;
      if (alpha > ALPHA_EPSILON) {
        const inv = useCoverage ? 1 / alpha : 1;
        dst[o] = encode(r * inv);
        dst[o + 1] = encode(g * inv);
        dst[o + 2] = encode(b * inv);
        dst[o + 3] = Math.round(alpha * 255);
      } else {
        dst[o] = 0;
        dst[o + 1] = 0;
        dst[o + 2] = 0;
        dst[o + 3] = 0;
      }
    }
  }
}

// Shared setup: validate, pick kernel, build LUTs and both axis weight tables.
function prepare(
  src: ResizeSource,
  dstWidth: number,
  dstHeight: number,
  opts: SeparableOptions,
) {
  if (src.data.length < src.width * src.height * COMPONENTS) {
    throw new Error('Source image data is too small.');
  }
  if (dstWidth < 3 || dstHeight < 3 || src.width < 3 || src.height < 3) {
    throw new Error('Source and destination sizes must be at least 3 pixels.');
  }
  if (dstWidth > src.width || dstHeight > src.height) {
    throw new Error('Resize does not support upscaling.');
  }

  const kernel = KERNELS[opts.kernel];
  return {
    useCoverage: opts.coverageWeightedAlpha,
    decode: buildDecodeLut(opts.sRGBGamma, opts.gamma),
    encode: makeEncode(opts.sRGBGamma, opts.gamma),
    xw: buildAxisWeights(src.width, dstWidth, kernel),
    yw: buildAxisWeights(src.height, dstHeight, kernel),
  };
}

/**
 * Downscale `src` to `dstWidth` x `dstHeight` with the selected separable filter.
 * Returns interleaved 8-bit straight-alpha RGBA pixels for the destination.
 */
export function resizeSeparable(
  src: ResizeSource,
  dstWidth: number,
  dstHeight: number,
  options: Partial<SeparableOptions> = {},
): Uint8ClampedArray<ArrayBuffer> {
  const opts = createSeparableOptions(options);
  const { useCoverage, decode, encode, xw, yw } = prepare(src, dstWidth, dstHeight, opts);

  // Whole-image: one full intermediate (srcHeight rows x dstWidth), then descale.
  const inter = new Float64Array(src.height * dstWidth * COMPONENTS);
  horizontalPass(src.data, src.width, xw, decode, useCoverage, 0, src.height, 0, dstWidth, inter);

  const dst = new Uint8ClampedArray(dstWidth * dstHeight * COMPONENTS);
  verticalPass(inter, 0, dstWidth, yw, encode, useCoverage, 0, dstHeight, 0, dstWidth, dst, dstWidth);
  return dst;
}

/**
 * Shrink-then-reduce downscale, for large ratios (thumbnails). Pure Lanczos over
 * a big source is pathological — support is r/scale source pixels per output, so
 * a 4000→200 (20×) downscale reads ~80 taps/axis/output. Instead: integer
 * **box-shrink** by `k = floor(scale_down)` per axis first (each output reads a
 * disjoint k×k block — every source pixel touched once, the cheapest correct
 * antialias), then run the requested kernel on the residual (now a <2× downscale,
 * a handful of taps). This is the strategy libvips uses; see docs/resampling.md.
 *
 * NOT bit-identical to {@link resizeSeparable} — box pre-filter + kernel residual
 * is a different (still high-quality) filter, and the intermediate round-trips
 * through 8-bit. For thumbnails that's the right trade: near-identical output, far
 * less work. Falls back to the plain path when neither axis shrinks ≥2×.
 *
 * `shrinkResidual` (default 2) sets how aggressively to box-shrink: k is chosen so
 * the residual scale stays in [1/shrinkResidual, 1) — larger = more box, less
 * kernel (faster, slightly softer).
 */
export function resizeThumbnail(
  src: ResizeSource,
  dstWidth: number,
  dstHeight: number,
  options: Partial<SeparableOptions> = {},
  shrinkResidual = 2,
): Uint8ClampedArray<ArrayBuffer> {
  // Integer shrink factor per axis: the largest k such that floor(dim/k) is still
  // >= dst*… i.e. the residual downscale (shrunk/dst) stays under shrinkResidual.
  // k = floor(src / (dst * shrinkResidual)) keeps shrunk >= dst*shrinkResidual,
  // so the residual ratio is in [1, 1/shrinkResidual)·… clamped to >= 1.
  const kx = Math.max(1, Math.floor(src.width / (dstWidth * shrinkResidual)));
  const ky = Math.max(1, Math.floor(src.height / (dstHeight * shrinkResidual)));

  // No meaningful pre-shrink available — just do the normal resize.
  if (kx === 1 && ky === 1) {
    return resizeSeparable(src, dstWidth, dstHeight, options);
  }

  const shrunkW = Math.floor(src.width / kx);
  const shrunkH = Math.floor(src.height / ky);

  // Stage 1: box-shrink (area average). Box is the correct cheap antialias for an
  // integer shrink and reuses the whole coverage/alpha/edge pipeline.
  const shrunk = resizeSeparable(src, shrunkW, shrunkH, { ...options, kernel: 'box' });
  const shrunkSrc: ResizeSource = { data: shrunk, width: shrunkW, height: shrunkH };

  // Stage 2: requested kernel on the residual (<2× downscale → few taps).
  return resizeSeparable(shrunkSrc, dstWidth, dstHeight, options);
}

/**
 * Tiled variant of {@link resizeSeparable}: plans disjoint output tiles, pulls
 * only each tile's input row region (the resample support), and resamples into
 * the shared destination. Single-threaded — this exists to validate the tiling
 * decomposition. Output is **bit-identical** to the whole-image path for any tile
 * size: both call the same passes with the same global weight tables, so every
 * output pixel sums the same source bytes in the same order. (No sharpen pass, so
 * the only apron is the resample-support input region — see tiled-scaler-plan.md.)
 */
export function resizeSeparableTiled(
  src: ResizeSource,
  dstWidth: number,
  dstHeight: number,
  tileWidth: number,
  tileHeight: number,
  options: Partial<SeparableOptions> = {},
): Uint8ClampedArray<ArrayBuffer> {
  const opts = createSeparableOptions(options);
  const { useCoverage, decode, encode, xw, yw } = prepare(src, dstWidth, dstHeight, opts);

  if (tileWidth < 1 || tileHeight < 1) {
    throw new Error('Tile size must be at least 1.');
  }

  const dst = new Uint8ClampedArray(dstWidth * dstHeight * COMPONENTS);

  for (let oy0 = 0; oy0 < dstHeight; oy0 += tileHeight) {
    const oy1 = Math.min(oy0 + tileHeight, dstHeight);

    // Input row region this tile's vertical taps reach (the resample apron).
    let iy0 = Infinity;
    let iy1 = 0;
    for (let oy = oy0; oy < oy1; ++oy) {
      iy0 = Math.min(iy0, yw.start[oy]);
      iy1 = Math.max(iy1, yw.start[oy] + yw.count[oy]);
    }

    for (let ox0 = 0; ox0 < dstWidth; ox0 += tileWidth) {
      const ox1 = Math.min(ox0 + tileWidth, dstWidth);
      const tileW = ox1 - ox0;

      // Per-tile intermediate: only the input rows this tile needs, only its cols.
      const inter = new Float64Array((iy1 - iy0) * tileW * COMPONENTS);
      horizontalPass(src.data, src.width, xw, decode, useCoverage, iy0, iy1, ox0, ox1, inter);
      verticalPass(inter, iy0, tileW, yw, encode, useCoverage, oy0, oy1, ox0, ox1, dst, dstWidth);
    }
  }
  return dst;
}

/** A planned output tile rect (half-open ranges over the destination). */
export interface TileRect {
  readonly ox0: number;
  readonly oy0: number;
  readonly ox1: number;
  readonly oy1: number;
}

/**
 * Everything a worker needs to resample any output tile of one image: the source,
 * the precomputed global weight tables, and the LUT/encode/coverage settings.
 * Built once on the main thread (or per worker) and reused across all tiles, so
 * tile output is bit-identical to the whole-image path.
 */
export interface TilingPlan {
  readonly src: ResizeSource;
  readonly dstWidth: number;
  readonly dstHeight: number;
  readonly tiles: readonly TileRect[];
  readonly xw: AxisWeights;
  readonly yw: AxisWeights;
  readonly decode: DecodeLut;
  readonly encode: Encode;
  readonly useCoverage: boolean;
}

/**
 * Plan a tiled resize: validate, build the global weight tables, and enumerate
 * the disjoint output tiles. The returned plan drives both single-threaded
 * iteration and the worker pool (each tile is an independent job).
 */
export function prepareTiling(
  src: ResizeSource,
  dstWidth: number,
  dstHeight: number,
  tileWidth: number,
  tileHeight: number,
  options: Partial<SeparableOptions> = {},
): TilingPlan {
  const opts = createSeparableOptions(options);
  const { useCoverage, decode, encode, xw, yw } = prepare(src, dstWidth, dstHeight, opts);
  if (tileWidth < 1 || tileHeight < 1) {
    throw new Error('Tile size must be at least 1.');
  }

  const tiles: TileRect[] = [];
  for (let oy0 = 0; oy0 < dstHeight; oy0 += tileHeight) {
    const oy1 = Math.min(oy0 + tileHeight, dstHeight);
    for (let ox0 = 0; ox0 < dstWidth; ox0 += tileWidth) {
      const ox1 = Math.min(ox0 + tileWidth, dstWidth);
      tiles.push({ ox0, oy0, ox1, oy1 });
    }
  }

  return { src, dstWidth, dstHeight, tiles, xw, yw, decode, encode, useCoverage };
}

/**
 * Resample one output tile of `plan` into a fresh, tile-sized RGBA buffer
 * (`(ox1-ox0) x (oy1-oy0)`). Pulls only the tile's input-row apron. The result is
 * bit-identical to the same rect of the whole-image output — it reuses the same
 * passes and global weight tables — so the pool can compute tiles independently
 * and the main thread blits each into place.
 */
export function resizeTileRegion(plan: TilingPlan, rect: TileRect): Uint8ClampedArray<ArrayBuffer> {
  const { src, xw, yw, decode, encode, useCoverage } = plan;
  const { ox0, oy0, ox1, oy1 } = rect;
  const tileW = ox1 - ox0;
  const tileH = oy1 - oy0;

  // Input row region this tile's vertical taps reach (the resample apron).
  let iy0 = Infinity;
  let iy1 = 0;
  for (let oy = oy0; oy < oy1; ++oy) {
    iy0 = Math.min(iy0, yw.start[oy]);
    iy1 = Math.max(iy1, yw.start[oy] + yw.count[oy]);
  }

  const inter = new Float64Array((iy1 - iy0) * tileW * COMPONENTS);
  horizontalPass(src.data, src.width, xw, decode, useCoverage, iy0, iy1, ox0, ox1, inter);

  // Tile-local destination: row width = tileW, origin (ox0, oy0).
  const tile = new Uint8ClampedArray(tileW * tileH * COMPONENTS);
  verticalPass(inter, iy0, tileW, yw, encode, useCoverage, oy0, oy1, ox0, ox1, tile, tileW, ox0, oy0);
  return tile;
}

/**
 * Like {@link resizeTileRegion} but writes the tile DIRECTLY into `dst` (a
 * full-destination buffer of `plan.dstWidth` x `plan.dstHeight`) at the rect's
 * position — no tile-local buffer, no blit. The SAB pool points `dst` at a shared
 * output so workers write disjoint rects in place. Still pulls only the tile's
 * apron, and the written pixels are bit-identical to the whole-image output.
 */
export function resizeTileRegionInto(
  plan: TilingPlan,
  rect: TileRect,
  dst: Uint8ClampedArray,
): void {
  const { src, dstWidth, xw, yw, decode, encode, useCoverage } = plan;
  const { ox0, oy0, ox1, oy1 } = rect;
  const tileW = ox1 - ox0;

  let iy0 = Infinity;
  let iy1 = 0;
  for (let oy = oy0; oy < oy1; ++oy) {
    iy0 = Math.min(iy0, yw.start[oy]);
    iy1 = Math.max(iy1, yw.start[oy] + yw.count[oy]);
  }

  const inter = new Float64Array((iy1 - iy0) * tileW * COMPONENTS);
  horizontalPass(src.data, src.width, xw, decode, useCoverage, iy0, iy1, ox0, ox1, inter);
  // Full-destination write: row width = dstWidth, origin (0,0) — rect lands in place.
  verticalPass(inter, iy0, tileW, yw, encode, useCoverage, oy0, oy1, ox0, ox1, dst, dstWidth, 0, 0);
}
