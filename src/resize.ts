// Gamma-correct image downscaler with optional sharpen / soften.
//
// A single-pass, area-averaging resampler that works in linear light: each
// source pixel is converted to linear via a gamma->linear LUT, accumulated with
// fractional coverage weights into the destination grid, then converted back to
// gamma-encoded 8-bit via a linear->gamma LUT.
//
// Alpha follows tiled-scaler-spec.md (§5.3-5.5): it is treated as linear
// coverage and never run through the transfer function, and color is
// accumulated alpha-weighted (implicit premultiply) so transparent pixels
// contribute no color. The accumulated color is un-premultiplied back to
// straight alpha on output. Setting `coverageWeightedAlpha = false` averages
// color straight instead, reproducing the classic dark-fringe artifact — kept
// for side-by-side comparison.
//
// Optional sharpening (§5.6) is an unsharp-mask cross kernel folded into the
// output stage, in linear light before encode. It runs in the premultiplied
// (coverage-weighted) domain — both the alpha-weighted color and the coverage
// are sharpened with the same kernel, then un-premultiplied — so a sharpened
// edge stays coverage-correct rather than smearin1g undefined color across the
// alpha boundary. `sharpeningCoefficient` 0 is identity, >0 sharpens, <0 softens.
//
// Scope: 8-bit RGBA, interleaved, downscale only.

// Number of components per pixel (RGBA).
const COMPONENTS = 4;

// Accumulated coverage at or below this is treated as fully transparent. This is
// a numerical floor for the un-premultiply divide only (sized to avoid 0/0), not
// a perceptual cutoff — keeping it tiny avoids eroding soft low-alpha edges.
const ALPHA_EPSILON = 1e-6;

// Bit depth for the gamma conversion tables, trading table size vs. quantization.
// Sharpening overshoots outside [0,1], so it needs the finer steps this provides.
const GAMMA_BIT_DEPTH = 5;

const GAMMA_MAX = (256 << GAMMA_BIT_DEPTH) - 1;
const INV_GAMMA_MAX = 1.0 / GAMMA_MAX;

const LINEAR_MAX = 512 << GAMMA_BIT_DEPTH;
const LINEAR_MIN = -(256 << GAMMA_BIT_DEPTH);

// Linear->gamma table length and the index bias for a value in [LINEAR_MIN, LINEAR_MAX).
const TABLE_LENGTH = LINEAR_MAX - LINEAR_MIN;
const INDEX_BIAS = -LINEAR_MIN;

// Convert an alpha-coverage value in the linear index domain (opaque = GAMMA_MAX)
// back to an 8-bit straight-alpha byte.
const INDEX_TO_ALPHA = 255 / GAMMA_MAX;

// The sRGB gamma constant for the power-law portion of the curve.
// https://en.wikipedia.org/wiki/SRGB#Transfer_function_(%22gamma%22)
const SRGB_GAMMA = 2.4;

type GammaTables = readonly [gammaToLinear: number[], linearToGamma: number[]];

// Table to convert sRGB -> linear (CIE XYZ).
// https://en.wikipedia.org/wiki/SRGB#From_sRGB_to_CIE_XYZ
function initSRGBGammaToLinear(): number[] {
  const result = new Array<number>(256);
  for (let i = 0; i < 256; ++i) {
    const c = i / 255.0;
    result[i] = (c < 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, SRGB_GAMMA);
  }
  return result;
}

// Table to convert linear (CIE XYZ) -> sRGB.
// https://en.wikipedia.org/wiki/SRGB#From_CIE_XYZ_to_sRGB
function initLinearToSRGBGamma(): number[] {
  const result = new Array<number>(TABLE_LENGTH);
  let i = LINEAR_MIN;
  for (; i < 0; ++i) {
    result[i - LINEAR_MIN] = 0;
  }
  const invGamma = 1.0 / SRGB_GAMMA;
  for (; i <= GAMMA_MAX; ++i) {
    const c = i * INV_GAMMA_MAX;
    if (c <= 0.0031308) {
      result[i - LINEAR_MIN] = 256.0 * 12.92 * c;
    } else {
      result[i - LINEAR_MIN] = 256.0 * (1.055 * Math.pow(c, invGamma) - 0.055);
    }
  }
  for (; i < LINEAR_MAX; ++i) {
    result[i - LINEAR_MIN] = 255.0;
  }
  return result;
}

const sRGBGammaTables: GammaTables = [initSRGBGammaToLinear(), initLinearToSRGBGamma()];

function initGammaToLinear(gamma: number): number[] {
  const result = new Array<number>(256);
  for (let i = 0; i < 256; ++i) {
    result[i] = Math.pow(i / 255.0, gamma);
  }
  return result;
}

function initLinearToGamma(gamma: number): number[] {
  const result = new Array<number>(TABLE_LENGTH);
  let i = LINEAR_MIN;
  for (; i < 0; ++i) {
    result[-LINEAR_MIN + i] = 0;
  }
  const invGamma = 1.0 / gamma;
  for (; i <= GAMMA_MAX; ++i) {
    const c = Math.pow(i * INV_GAMMA_MAX, invGamma);
    result[-LINEAR_MIN + i] = (c >= 1.0) ? 255 : Math.round(c * 255.0);
  }
  for (; i < LINEAR_MAX; ++i) {
    result[-LINEAR_MIN + i] = 255;
  }
  return result;
}

function initGammaTables(gamma: number): GammaTables {
  return [initGammaToLinear(gamma), initLinearToGamma(gamma)];
}

export class ResizeOptions {
  /** Use the sRGB piecewise transfer function. When false, use `gamma`. */
  sRGBGamma = true;
  /** Pure-power gamma exponent, used only when `sRGBGamma` is false. */
  gamma = 2.2;
  /**
   * Alpha-weight color so transparent pixels contribute no color (spec-correct,
   * no edge fringing). When false, color is averaged straight — kept for
   * demonstrating the dark-halo artifact. Alpha is linear coverage either way.
   */
  coverageWeightedAlpha = true;
  /**
   * Unsharp-mask amount applied in linear light. 0 = identity (no extra work),
   * >0 sharpens, <0 softens. Range [-1, 1].
   */
  sharpeningCoefficient = 0;
}

/** Minimal source shape: an `ImageData`, or anything with the same fields. */
export interface ResizeSource {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Downscale `src` to `dstWidth` x `dstHeight`, resampling in linear light.
 * Returns interleaved 8-bit straight-alpha RGBA pixels for the destination.
 */
export function resize(
  src: ResizeSource,
  dstWidth: number,
  dstHeight: number,
  options: ResizeOptions = new ResizeOptions(),
): Uint8ClampedArray<ArrayBuffer> {
  const srcData = src.data;
  const srcWidth = src.width;
  const srcHeight = src.height;

  if (srcData.length < srcWidth * srcHeight * COMPONENTS) {
    throw new Error('Source image data is too small.');
  }

  if (dstWidth < 3 || dstHeight < 3 || srcWidth < 3 || srcHeight < 3) {
    throw new Error('Source and destination sizes must be at least 3 pixels.');
  }

  if (dstWidth > srcWidth || dstHeight > srcHeight) {
    throw new Error('Resize does not support upscaling.');
  }

  const sharpen = options.sharpeningCoefficient;
  if (sharpen < -1 || sharpen > 1) {
    throw new Error('Sharpening amount must be from -1 to 1.');
  }

  // Tables to convert between gamma-encoded color and linear light.
  const [gammaToLinear, linearToGamma] = options.sRGBGamma
    ? sRGBGammaTables
    : initGammaTables(options.gamma);

  // Coverage weighting: alpha-weight color (true) or average it straight (false).
  const useCoverage = options.coverageWeightedAlpha;

  const fixedXScale = 1.0 / dstWidth;
  const fixedYScale = 1.0 / dstHeight;

  const srcSize = srcWidth * srcHeight;
  const srcStride = srcWidth * COMPONENTS;

  const dstSize = dstWidth * dstHeight;
  const dstStride = dstWidth * COMPONENTS;

  // Reciprocal of the source-pixel area mapped to each output pixel (i.e. of the
  // sum of coverage weights). `invArea` turns an accumulated coverage sum into an
  // average; `fixedXYScale` additionally scales an average linear value into the
  // linear->gamma table's index domain. `premulScale` does the same for an
  // alpha-weighted (premultiplied) sum, where the extra /255 normalizes the raw
  // 0..255 alpha factor so opaque white lands at GAMMA_MAX.
  const invArea = dstSize / srcSize;
  const fixedXYScale = GAMMA_MAX * invArea;
  const premulScale = fixedXYScale / 255;

  let accumRow = new Float64Array(dstStride);
  let fractionRow = new Float64Array(dstStride);
  let yAccum = srcHeight;

  const dst = new Uint8ClampedArray(dstWidth * dstHeight * COMPONENTS);

  // Linear->gamma encode of a single channel value in the index domain, clamped
  // to the table range (sharpening / un-premultiply can push it out of bounds).
  const encode = (v: number): number => {
    let idx = (INDEX_BIAS + v + 0.5) | 0;
    if (idx < 0) {
      idx = 0;
    } else if (idx >= TABLE_LENGTH) {
      idx = TABLE_LENGTH - 1;
    }
    return linearToGamma[idx];
  };

  // 3-row delay line of scaled linear output, used only when sharpening. Each
  // row holds, per output pixel, the (premultiplied, when coverage-weighted)
  // linear color in index domain plus the coverage in the same domain.
  const rows: Float64Array[] = sharpen !== 0
    ? [new Float64Array(dstStride), new Float64Array(dstStride), new Float64Array(dstStride)]
    : [];
  // Top edge replicates, matching the bottom-edge handling below.
  let row1 = rows[2] ?? accumRow;
  let row2 = row1;
  let row3 = row1;

  // Sharpen output row `mid` (with vertical neighbors `top`/`bot`) using an
  // unsharp cross kernel, reconstruct straight RGBA, and write to `dst` at
  // `offset`. Horizontal edge pixels replicate. out = (1+c)·mid − 0.25c·Σneighbors.
  const k1 = 1 + sharpen;
  const k2 = 0.25 * sharpen;
  const s = new Float64Array(COMPONENTS);
  const sharpenLine = (
    top: Float64Array,
    mid: Float64Array,
    bot: Float64Array,
    offset: number,
  ): void => {
    for (let col = 0; col < dstWidth; ++col) {
      const base = col * COMPONENTS;
      const leftBase = col > 0 ? base - COMPONENTS : base;
      const rightBase = col < dstWidth - 1 ? base + COMPONENTS : base;

      for (let c = 0; c < COMPONENTS; ++c) {
        const m = mid[base + c];
        s[c] = k1 * m - k2 * (mid[leftBase + c] + mid[rightBase + c] + top[base + c] + bot[base + c]);
      }

      const a = s[3];
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      if (a > ALPHA_EPSILON) {
        const inv = useCoverage ? (GAMMA_MAX / a) : 1;
        r = encode(s[0] * inv);
        g = encode(s[1] * inv);
        b = encode(s[2] * inv);
        alpha = a * INDEX_TO_ALPHA;
      }
      dst[offset + base] = r;
      dst[offset + base + 1] = g;
      dst[offset + base + 2] = b;
      dst[offset + base + 3] = alpha;
    }
  };

  let srcOffset = 0;
  let dstOffset = 0;
  let yOut = 0;

  for (let y = 0; y < srcHeight; ++y) {
    let offset = srcOffset;

    yAccum -= dstHeight;

    const emitY = yAccum <= 0;
    let yScale = 0.0;

    if (emitY) {
      yScale = fixedYScale * (-yAccum);
      yAccum += srcHeight;
    }

    let xOut = 0;
    let fxOut = 0;
    let xAccum = 0.0;
    let pxRed = 0.0;
    let pxGreen = 0.0;
    let pxBlue = 0.0;
    let pxAlpha = 0.0;

    for (let count = dstWidth; count > 0; --count) {
      xAccum += srcWidth - dstWidth;
      while (xAccum > 0) {
        const a = srcData[offset + 3];
        const cw = useCoverage ? a : 1;
        pxRed += gammaToLinear[srcData[offset]] * cw;
        pxGreen += gammaToLinear[srcData[offset + 1]] * cw;
        pxBlue += gammaToLinear[srcData[offset + 2]] * cw;
        pxAlpha += a;
        offset += COMPONENTS;
        xAccum -= dstWidth;
      }

      const xScale = fixedXScale * (-xAccum);

      const a = srcData[offset + 3];
      const cw = useCoverage ? a : 1;

      const baseRed = gammaToLinear[srcData[offset]] * cw;
      const fracRed = baseRed * xScale;
      const contRed = pxRed + baseRed - fracRed;
      accumRow[xOut++] += contRed;
      pxRed = fracRed;

      const baseGreen = gammaToLinear[srcData[offset + 1]] * cw;
      const fracGreen = baseGreen * xScale;
      const contGreen = pxGreen + baseGreen - fracGreen;
      accumRow[xOut++] += contGreen;
      pxGreen = fracGreen;

      const baseBlue = gammaToLinear[srcData[offset + 2]] * cw;
      const fracBlue = baseBlue * xScale;
      const contBlue = pxBlue + baseBlue - fracBlue;
      accumRow[xOut++] += contBlue;
      pxBlue = fracBlue;

      const baseAlpha = a;
      const fracAlpha = baseAlpha * xScale;
      const contAlpha = pxAlpha + baseAlpha - fracAlpha;
      accumRow[xOut++] += contAlpha;
      pxAlpha = fracAlpha;

      offset += COMPONENTS;

      if (emitY) {
        fractionRow[fxOut++] = contRed * yScale;
        fractionRow[fxOut++] = contGreen * yScale;
        fractionRow[fxOut++] = contBlue * yScale;
        fractionRow[fxOut++] = contAlpha * yScale;
      }
    }

    if (emitY) {
      // Color scale: premultiplied color divides the alpha back out at emit, so
      // it is stored alpha-weighted (premulScale); straight color is not.
      const colorScale = useCoverage ? premulScale : fixedXYScale;

      if (sharpen === 0) {
        let x = 0;
        for (let col = 0; col < dstWidth; ++col) {
          // Accumulated coverage Σ(w·a) for this output pixel.
          const coverage = accumRow[x + 3] - fractionRow[x + 3];

          let r = 0;
          let g = 0;
          let b = 0;
          let alpha = 0;

          if (coverage > ALPHA_EPSILON) {
            // Alpha is the plain coverage average; color divides by the coverage
            // (un-premultiply) when coverage-weighted, else by the box area.
            alpha = coverage * invArea;
            const inv = useCoverage ? (GAMMA_MAX / coverage) : fixedXYScale;
            r = encode((accumRow[x] - fractionRow[x]) * inv);
            g = encode((accumRow[x + 1] - fractionRow[x + 1]) * inv);
            b = encode((accumRow[x + 2] - fractionRow[x + 2]) * inv);
          }

          dst[dstOffset + x] = r;
          dst[dstOffset + x + 1] = g;
          dst[dstOffset + x + 2] = b;
          dst[dstOffset + x + 3] = alpha;
          x += COMPONENTS;
        }
      } else {
        // Store this output row's scaled linear values into the delay line.
        for (let x = 0; x < dstStride; x += COMPONENTS) {
          row3[x] = (accumRow[x] - fractionRow[x]) * colorScale;
          row3[x + 1] = (accumRow[x + 1] - fractionRow[x + 1]) * colorScale;
          row3[x + 2] = (accumRow[x + 2] - fractionRow[x + 2]) * colorScale;
          row3[x + 3] = (accumRow[x + 3] - fractionRow[x + 3]) * premulScale;
        }

        if (yOut > 0) {
          // Finalize the previous row now that its bottom neighbor exists.
          sharpenLine(row1, row2, row3, dstOffset - dstStride);
          if (yOut === dstHeight - 1) {
            // Last row: replicate the bottom neighbor.
            sharpenLine(row2, row3, row3, dstOffset);
          }
        }

        row1 = row2;
        row2 = row3;
        row3 = rows[yOut % 3];
      }

      const tmp = accumRow;
      accumRow = fractionRow;
      fractionRow = tmp;

      dstOffset += dstStride;
      ++yOut;
    }

    srcOffset += srcStride;
  }

  return dst;
}
