// Separable, filtered image downscaler — C/Wasm port of src/separable.ts.
//
// Deliberately a close transcription of the TS reference so its output can be
// tolerance-compared against the oracle (separable.ts) — the spec (§8) requires
// only ~1 LSB agreement across implementations, not bit-identity, because of
// double-vs-float and differing transcendental implementations. This port uses
// `double` internally (matching the TS Float64Array accumulators) to keep that
// gap as small as possible; the SIMD specialization (f32x4) comes later and is
// where the float-precision divergence will actually appear.
//
// Structure mirrors separable.ts exactly: precomputed per-axis weight tables
// (independent output pixels), a horizontal pass into a linear premultiplied
// intermediate, then a vertical pass that un-premultiplies and encodes. Alpha is
// coverage-weighted (spec §5.4); out-of-bounds taps get weight 0 and the
// remainder is renormalized (edge policy §5.5).
//
// Memory model: the caller (JS) owns a single linear-memory arena it grows as
// needed and passes explicit pointers in. We expose malloc/free via Emscripten
// so the worker can stage the source bytes and read back the destination.

#include <emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// When compiled with -msimd128, the tap loops accumulate with f32x4 (one RGBA
// pixel per 128-bit vector) and the linear intermediate is float; otherwise the
// kernel is fully scalar with a double intermediate (bit-identical to the TS
// oracle). Both agree within the ≤1 LSB tolerance (spec §8).
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#define SIMD_BUILD 1
typedef float inter_t;
#else
#define SIMD_BUILD 0
typedef double inter_t;
#endif

#define COMPONENTS 4
#define ALPHA_EPSILON 1e-6
#define SRGB_GAMMA 2.4
#define INV_SRGB_GAMMA (1.0 / SRGB_GAMMA)

// Forward declaration: resize_init / resize_tile clean up via resize_free.
typedef struct ResizeCtx ResizeCtx;
void resize_free(ResizeCtx *ctx);

// Kernel ids — must match the order/encoding used on the JS side.
enum Kernel {
  KERNEL_BOX = 0,
  KERNEL_TRIANGLE = 1,
  KERNEL_MITCHELL = 2,
  KERNEL_LANCZOS2 = 3,
  KERNEL_LANCZOS3 = 4,
};

static double sinc(double x) {
  if (x == 0.0) {
    return 1.0;
  }
  double px = M_PI * x;
  return sin(px) / px;
}

// Mitchell-Netravali with B = C = 1/3.
static double mitchell(double x) {
  const double B = 1.0 / 3.0;
  const double C = 1.0 / 3.0;
  double ax = fabs(x);
  double ax2 = ax * ax;
  double ax3 = ax2 * ax;
  if (ax < 1.0) {
    return ((12 - 9 * B - 6 * C) * ax3 + (-18 + 12 * B + 6 * C) * ax2 + (6 - 2 * B)) / 6.0;
  }
  if (ax < 2.0) {
    return ((-B - 6 * C) * ax3 + (6 * B + 30 * C) * ax2 + (-12 * B - 48 * C) * ax
            + (8 * B + 24 * C)) / 6.0;
  }
  return 0.0;
}

static double kernel_weight(int kernel, double x) {
  double ax = fabs(x);
  switch (kernel) {
    case KERNEL_BOX: return ax < 0.5 ? 1.0 : 0.0;
    case KERNEL_TRIANGLE: return ax < 1.0 ? 1.0 - ax : 0.0;
    case KERNEL_MITCHELL: return mitchell(x);
    case KERNEL_LANCZOS2: return ax < 2.0 ? sinc(x) * sinc(x / 2.0) : 0.0;
    case KERNEL_LANCZOS3: return ax < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0;
    default: return 0.0;
  }
}

static double kernel_radius(int kernel) {
  switch (kernel) {
    case KERNEL_BOX: return 0.5;
    case KERNEL_TRIANGLE: return 1.0;
    case KERNEL_MITCHELL: return 2.0;
    case KERNEL_LANCZOS2: return 2.0;
    case KERNEL_LANCZOS3: return 3.0;
    default: return 0.5;
  }
}

// Per-axis tap table, flattened. start[o]/count[o] index source samples; the
// `count[o]` weights for output o begin at offset[o] in `weight`. Mirrors the
// AxisWeights shape in separable.ts.
typedef struct {
  int32_t *start;
  int32_t *count;
  int32_t *offset;
  double *weight;
  int total; // total tap count across all outputs
} AxisWeights;

static int build_axis_weights(int srcN, int dstN, int kernel, AxisWeights *out) {
  double scale = (double)dstN / (double)srcN;
  double filter_scale = scale < 1.0 ? scale : 1.0;
  double support = kernel_radius(kernel) / filter_scale;

  out->start = (int32_t *)malloc(sizeof(int32_t) * dstN);
  out->count = (int32_t *)malloc(sizeof(int32_t) * dstN);
  out->offset = (int32_t *)malloc(sizeof(int32_t) * dstN);
  if (!out->start || !out->count || !out->offset) {
    return 0;
  }

  // First pass: count taps so we can size the weight array exactly.
  int total = 0;
  for (int o = 0; o < dstN; ++o) {
    double center = (o + 0.5) / scale - 0.5;
    int left = (int)ceil(center - support);
    int right = (int)floor(center + support);
    if (left < 0) {
      left = 0;
    }
    if (right > srcN - 1) {
      right = srcN - 1;
    }
    int count = right >= left ? (right - left + 1) : 0;
    out->start[o] = left;
    out->count[o] = count;
    out->offset[o] = total;
    total += count;
  }

  out->total = total;
  out->weight = (double *)malloc(sizeof(double) * (total > 0 ? total : 1));
  if (!out->weight) {
    return 0;
  }

  // Second pass: evaluate and renormalize each output's weights to sum to 1.
  for (int o = 0; o < dstN; ++o) {
    double center = (o + 0.5) / scale - 0.5;
    int left = out->start[o];
    int count = out->count[o];
    int woff = out->offset[o];
    double sum = 0.0;
    for (int t = 0; t < count; ++t) {
      double w = kernel_weight(kernel, ((left + t) - center) * filter_scale);
      out->weight[woff + t] = w;
      sum += w;
    }
    double inv = sum != 0.0 ? 1.0 / sum : 0.0;
    for (int t = 0; t < count; ++t) {
      out->weight[woff + t] *= inv;
    }
  }
  return 1;
}

static void free_axis_weights(AxisWeights *w) {
  free(w->start);
  free(w->count);
  free(w->offset);
  free(w->weight);
}

// sRGB / power-law decode LUT (256 entries) into linear light.
static void build_decode_lut(double *lut, int use_srgb, double gamma) {
  for (int i = 0; i < 256; ++i) {
    double c = i / 255.0;
    if (use_srgb) {
      lut[i] = c < 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, SRGB_GAMMA);
    } else {
      lut[i] = pow(c, gamma);
    }
  }
}

static double encode_channel(double c, int use_srgb, double inv_gamma) {
  if (c <= 0.0) {
    return 0.0;
  }
  if (c >= 1.0) {
    return 255.0;
  }
  double s;
  if (use_srgb) {
    s = c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, INV_SRGB_GAMMA) - 0.055;
  } else {
    s = pow(c, inv_gamma);
  }
  return round(s * 255.0);
}

// Pre-linearize: decode + premultiply every source pixel ONCE into a contiguous
// linear RGBA buffer. The LUT gather and per-pixel coverage weight (decode[c]*a,
// a) are tap-independent, so hoisting them here lets the horizontal tap loop read
// contiguous vectors with no gather — what makes SIMD pay off (docs/resampling.md:
// the no-gather caveat). Layout: srcH x srcW x 4, RGB premultiplied when coverage.
static void prelinearize(
    const uint8_t *src, int srcW, int srcH,
    const double *decode, int coverage, inter_t *lin) {
  size_t n = (size_t)srcW * srcH;
  for (size_t i = 0; i < n; ++i) {
    const uint8_t *p = src + i * COMPONENTS;
    inter_t *o = lin + i * COMPONENTS;
    inter_t pa = (inter_t)(p[3] / 255.0);
    inter_t cw = coverage ? pa : (inter_t)1.0;
    o[0] = (inter_t)decode[p[0]] * cw;
    o[1] = (inter_t)decode[p[1]] * cw;
    o[2] = (inter_t)decode[p[2]] * cw;
    o[3] = pa;
  }
}

// Horizontal pass over input rows [iy0,iy1) and output cols [ox0,ox1): resample
// the pre-linearized buffer `lin` (row stride srcW*4) into `inter`, laid out
// local to the region ((iy1-iy0) rows x (ox1-ox0) cols). Row-major; see the
// transpose note below.
//
// NOTE: transposing the intermediate to column-major (so the vertical pass reads
// contiguously) was tried and measured SLOWER — it only moves the stride from the
// pass-2 read to the pass-1 write, and scattered strided WRITES cost more than
// strided reads (writes thrash the write-combining buffer; reads prefetch). The
// real cache win is tiling, not transposition.
// `lin` holds input rows starting at absolute row `linRowBase` (0 for a
// whole-image buffer, iy0 for a tile's apron band).
static void horizontal_pass(
    const inter_t *lin, int linRowBase, int srcW, const AxisWeights *xw,
    int iy0, int iy1, int ox0, int ox1, inter_t *inter) {
  int lin_stride = srcW * COMPONENTS;
  int inter_stride = (ox1 - ox0) * COMPONENTS;
  for (int y = iy0; y < iy1; ++y) {
    const inter_t *lin_row = lin + (size_t)(y - linRowBase) * lin_stride;
    inter_t *inter_row = inter + (size_t)(y - iy0) * inter_stride;
    for (int ox = ox0; ox < ox1; ++ox) {
      int start = xw->start[ox];
      int count = xw->count[ox];
      int woff = xw->offset[ox];
      inter_t *o = inter_row + (ox - ox0) * COMPONENTS;
#if SIMD_BUILD
      v128_t acc = wasm_f32x4_const_splat(0.0f);
      for (int t = 0; t < count; ++t) {
        float w = (float)xw->weight[woff + t];
        const inter_t *p = lin_row + (size_t)(start + t) * COMPONENTS;
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_splat(w), wasm_v128_load(p)));
      }
      wasm_v128_store(o, acc);
#else
      double r = 0, g = 0, b = 0, a = 0;
      for (int t = 0; t < count; ++t) {
        double w = xw->weight[woff + t];
        const inter_t *p = lin_row + (size_t)(start + t) * COMPONENTS;
        r += w * p[0];
        g += w * p[1];
        b += w * p[2];
        a += w * p[3];
      }
      o[0] = r;
      o[1] = g;
      o[2] = b;
      o[3] = a;
#endif
    }
  }
}

// Vertical pass over output rows [oy0,oy1) and cols [ox0,ox1): resample `inter`
// (rows based at interRowBase, region width interTileW) then un-premultiply and
// encode into `dst`, addressed as dstRowW pixels/row with the region's top-left
// at (dstOx0,dstOy0). Pass (dstW,0,0) for full-image output or (tileW,ox0,oy0)
// for a tile-local buffer; the arithmetic is identical, so tiles are bit-identical
// to the whole-image path.
static void vertical_pass(
    const inter_t *inter, int interRowBase, int interTileW, const AxisWeights *yw,
    int use_srgb, double inv_gamma, int coverage,
    int oy0, int oy1, int ox0, int ox1,
    uint8_t *dst, int dstRowW, int dstOx0, int dstOy0) {
  int inter_stride = interTileW * COMPONENTS;
  int dst_stride = dstRowW * COMPONENTS;
  for (int oy = oy0; oy < oy1; ++oy) {
    int start = yw->start[oy];
    int count = yw->count[oy];
    int woff = yw->offset[oy];
    uint8_t *dst_row = dst + (size_t)(oy - dstOy0) * dst_stride;
    for (int ox = ox0; ox < ox1; ++ox) {
      int col = (ox - ox0) * COMPONENTS;
      double r, g, b, a;
#if SIMD_BUILD
      v128_t acc = wasm_f32x4_const_splat(0.0f);
      for (int t = 0; t < count; ++t) {
        float w = (float)yw->weight[woff + t];
        const inter_t *p = inter + (size_t)(start + t - interRowBase) * inter_stride + col;
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_splat(w), wasm_v128_load(p)));
      }
      r = wasm_f32x4_extract_lane(acc, 0);
      g = wasm_f32x4_extract_lane(acc, 1);
      b = wasm_f32x4_extract_lane(acc, 2);
      a = wasm_f32x4_extract_lane(acc, 3);
#else
      r = 0, g = 0, b = 0, a = 0;
      for (int t = 0; t < count; ++t) {
        double w = yw->weight[woff + t];
        const inter_t *p = inter + (size_t)(start + t - interRowBase) * inter_stride + col;
        r += w * p[0];
        g += w * p[1];
        b += w * p[2];
        a += w * p[3];
      }
#endif
      uint8_t *o = dst_row + (ox - dstOx0) * COMPONENTS;
      if (a > ALPHA_EPSILON) {
        double inv = coverage ? 1.0 / a : 1.0;
        o[0] = (uint8_t)encode_channel(r * inv, use_srgb, inv_gamma);
        o[1] = (uint8_t)encode_channel(g * inv, use_srgb, inv_gamma);
        o[2] = (uint8_t)encode_channel(b * inv, use_srgb, inv_gamma);
        // Negative-lobe kernels can push coverage past 1.0; clamp before the cast
        // (a bare uint8_t cast wraps 256->0; JS Uint8ClampedArray clamps to 255).
        double av = round(a * 255.0);
        o[3] = (uint8_t)(av < 0.0 ? 0.0 : (av > 255.0 ? 255.0 : av));
      } else {
        o[0] = 0;
        o[1] = 0;
        o[2] = 0;
        o[3] = 0;
      }
    }
  }
}

/**
 * Downscale straight-alpha RGBA8 `src` (srcW x srcH) into `dst` (dstW x dstH).
 * Whole-image path. Returns 1 on success, 0 on bad dims / alloc failure.
 */
EMSCRIPTEN_KEEPALIVE
int resize_rgba(
    const uint8_t *src, int srcW, int srcH,
    uint8_t *dst, int dstW, int dstH,
    int kernel, int use_srgb, double gamma, int coverage) {
  if (dstW < 3 || dstH < 3 || srcW < 3 || srcH < 3) {
    return 0;
  }
  if (dstW > srcW || dstH > srcH) {
    return 0;
  }

  AxisWeights xw = {0};
  AxisWeights yw = {0};
  if (!build_axis_weights(srcW, dstW, kernel, &xw)
      || !build_axis_weights(srcH, dstH, kernel, &yw)) {
    free_axis_weights(&xw);
    free_axis_weights(&yw);
    return 0;
  }

  double decode[256];
  build_decode_lut(decode, use_srgb, gamma);
  double inv_gamma = 1.0 / gamma;

  size_t src_px = (size_t)srcW * srcH;
  inter_t *lin = (inter_t *)malloc(sizeof(inter_t) * src_px * COMPONENTS);
  inter_t *inter = (inter_t *)malloc(sizeof(inter_t) * (size_t)srcH * dstW * COMPONENTS);
  if (!lin || !inter) {
    free(lin);
    free(inter);
    free_axis_weights(&xw);
    free_axis_weights(&yw);
    return 0;
  }

  prelinearize(src, srcW, srcH, decode, coverage, lin);
  horizontal_pass(lin, 0, srcW, &xw, 0, srcH, 0, dstW, inter);
  free(lin);
  vertical_pass(inter, 0, dstW, &yw, use_srgb, inv_gamma, coverage,
                0, dstH, 0, dstW, dst, dstW, 0, 0);

  free(inter);
  free_axis_weights(&xw);
  free_axis_weights(&yw);
  return 1;
}

// ============================================================================
//  Tiled / pool API
// ----------------------------------------------------------------------------
// Source-resident context for the worker pool: build the weight tables and
// pre-linearized source ONCE (resize_init), then resample any number of output
// tiles (resize_tile), each into a tile-local buffer, before resize_free. This
// mirrors the TS pool (prepareTiling / resizeTileRegion) and amortizes the
// per-image setup across all of a worker's tiles.

// The context keeps a COPY of the raw source bytes + the decode LUT — NOT a
// pre-linearized whole-image buffer. Each resize_tile pre-linearizes only its
// own apron band on demand. This keeps per-worker memory tile-bounded: a prior
// version pre-linearized the whole image in resize_init, which in a pool meant
// every worker held an srcW*srcH*4*sizeof(inter_t) buffer (268 MB each at 4096²
// f32) for the WHOLE image redundantly — pathological. Lazy per-tile band
// matches the TS pool and still feeds SIMD contiguous f32.
struct ResizeCtx {
  int srcW, srcH, dstW, dstH;
  int use_srgb, coverage;
  double inv_gamma;
  AxisWeights xw, yw;
  uint8_t *src;     // copy of the source RGBA bytes
  double decode[256];
};

EMSCRIPTEN_KEEPALIVE
ResizeCtx *resize_init(
    const uint8_t *src, int srcW, int srcH, int dstW, int dstH,
    int kernel, int use_srgb, double gamma, int coverage) {
  if (dstW < 3 || dstH < 3 || srcW < 3 || srcH < 3 || dstW > srcW || dstH > srcH) {
    return 0;
  }
  ResizeCtx *ctx = (ResizeCtx *)calloc(1, sizeof(ResizeCtx));
  if (!ctx) {
    return 0;
  }
  ctx->srcW = srcW;
  ctx->srcH = srcH;
  ctx->dstW = dstW;
  ctx->dstH = dstH;
  ctx->use_srgb = use_srgb;
  ctx->coverage = coverage;
  ctx->inv_gamma = 1.0 / gamma;
  build_decode_lut(ctx->decode, use_srgb, gamma);

  size_t src_bytes = (size_t)srcW * srcH * COMPONENTS;
  ctx->src = (uint8_t *)malloc(src_bytes);
  if (!ctx->src
      || !build_axis_weights(srcW, dstW, kernel, &ctx->xw)
      || !build_axis_weights(srcH, dstH, kernel, &ctx->yw)) {
    resize_free(ctx);
    return 0;
  }
  memcpy(ctx->src, src, src_bytes);
  return ctx;
}

/**
 * Resample one output tile [ox0,ox1) x [oy0,oy1) of `ctx` into `dst_tile`, a
 * tile-local buffer of (ox1-ox0) x (oy1-oy0) RGBA pixels. Pre-linearizes only the
 * tile's input-row apron (tile-bounded memory). Bit-identical to the same rect of
 * the whole-image output.
 */
EMSCRIPTEN_KEEPALIVE
int resize_tile(ResizeCtx *ctx, int ox0, int oy0, int ox1, int oy1, uint8_t *dst_tile) {
  if (!ctx || ox0 < 0 || oy0 < 0 || ox1 > ctx->dstW || oy1 > ctx->dstH
      || ox1 <= ox0 || oy1 <= oy0) {
    return 0;
  }
  int tileW = ox1 - ox0;
  int srcW = ctx->srcW;

  // Input row region the tile's vertical taps reach (the resample apron).
  int iy0 = ctx->srcH;
  int iy1 = 0;
  for (int oy = oy0; oy < oy1; ++oy) {
    int s = ctx->yw.start[oy];
    int e = s + ctx->yw.count[oy];
    if (s < iy0) {
      iy0 = s;
    }
    if (e > iy1) {
      iy1 = e;
    }
  }
  int bandH = iy1 - iy0;

  // Pre-linearize just this band ([iy0,iy1) x full width), then resample. The
  // band, not the whole image, bounds the scratch memory.
  inter_t *lin = (inter_t *)malloc(sizeof(inter_t) * (size_t)bandH * srcW * COMPONENTS);
  inter_t *inter = (inter_t *)malloc(sizeof(inter_t) * (size_t)bandH * tileW * COMPONENTS);
  if (!lin || !inter) {
    free(lin);
    free(inter);
    return 0;
  }
  prelinearize(ctx->src + (size_t)iy0 * srcW * COMPONENTS, srcW, bandH,
               ctx->decode, ctx->coverage, lin);
  horizontal_pass(lin, iy0, srcW, &ctx->xw, iy0, iy1, ox0, ox1, inter);
  vertical_pass(inter, iy0, tileW, &ctx->yw, ctx->use_srgb, ctx->inv_gamma, ctx->coverage,
                oy0, oy1, ox0, ox1, dst_tile, tileW, ox0, oy0);
  free(lin);
  free(inter);
  return 1;
}

EMSCRIPTEN_KEEPALIVE
void resize_free(ResizeCtx *ctx) {
  if (!ctx) {
    return;
  }
  free_axis_weights(&ctx->xw);
  free_axis_weights(&ctx->yw);
  free(ctx->src);
  free(ctx);
}
