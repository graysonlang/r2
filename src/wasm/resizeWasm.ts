// Typed wrapper around the emcc-compiled resize kernel (src/wasm/resize.c).
//
// The C source is imported via esp's emcc esbuild plugin, which compiles it to a
// MODULARIZE/EXPORT_ES6 Emscripten factory. We instantiate it once and reuse the
// instance (the WebAssembly.Module compile is the expensive part; reusing it
// matches the spec's "precompile once, reuse across spawns" note). Calls stage
// the source bytes into linear memory, invoke resize_rgba, and copy the result
// out.

import createModule from './resize.c';
import type { KernelName } from '../separable';

interface EmscriptenModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _resize_rgba(
    src: number, srcW: number, srcH: number,
    dst: number, dstW: number, dstH: number,
    kernel: number, useSrgb: number, gamma: number, coverage: number,
  ): number;
  // Tile/pool context API (see src/wasm/resize.c).
  _resize_init(
    src: number, srcW: number, srcH: number, dstW: number, dstH: number,
    kernel: number, useSrgb: number, gamma: number, coverage: number,
  ): number;
  _resize_tile(ctx: number, ox0: number, oy0: number, ox1: number, oy1: number, dstTile: number): number;
  _resize_free(ctx: number): void;
}

// Must match the enum in src/wasm/resize.c.
const KERNEL_ID: Record<KernelName, number> = {
  box: 0,
  triangle: 1,
  mitchell: 2,
  lanczos2: 3,
  lanczos3: 4,
};

export interface WasmResizeOptions {
  kernel: KernelName;
  sRGBGamma: boolean;
  gamma: number;
  coverageWeightedAlpha: boolean;
}

let modulePromise: Promise<EmscriptenModule> | null = null;

/** Instantiate (once) and cache the Wasm module instance. */
export function loadResizeWasm(): Promise<EmscriptenModule> {
  modulePromise ??= (createModule() as Promise<unknown>).then(m => m as EmscriptenModule);
  return modulePromise;
}

/**
 * Downscale straight-alpha RGBA `src` (`srcW`x`srcH`) to `dstW`x`dstH` using the
 * Wasm kernel. Returns a fresh RGBA buffer. `mod` is the instance from
 * {@link loadResizeWasm}.
 */
export function resizeWasm(
  mod: EmscriptenModule,
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  options: WasmResizeOptions,
): Uint8ClampedArray<ArrayBuffer> {
  const srcBytes = srcW * srcH * 4;
  const dstBytes = dstW * dstH * 4;
  const srcPtr = mod._malloc(srcBytes);
  const dstPtr = mod._malloc(dstBytes);
  try {
    mod.HEAPU8.set(src.subarray(0, srcBytes), srcPtr);
    const ok = mod._resize_rgba(
      srcPtr, srcW, srcH,
      dstPtr, dstW, dstH,
      KERNEL_ID[options.kernel], options.sRGBGamma ? 1 : 0, options.gamma,
      options.coverageWeightedAlpha ? 1 : 0,
    );
    if (!ok) {
      throw new Error('resize_rgba failed (bad dimensions or allocation).');
    }
    // Copy out of the heap before it can move (malloc/free or growth).
    const out = new Uint8ClampedArray(dstBytes);
    out.set(mod.HEAPU8.subarray(dstPtr, dstPtr + dstBytes));
    return out;
  } finally {
    mod._free(srcPtr);
    mod._free(dstPtr);
  }
}

/**
 * Source-resident Wasm resize context for the pool: builds the weight tables +
 * pre-linearized source once (resize_init), then resamples output tiles into
 * tile-local buffers (resize_tile). Mirrors the TS `TilingPlan` /
 * `resizeTileRegion` so the Wasm pool worker matches the TS one. Call `free()`
 * when done.
 */
export class WasmTileContext {
  private ctx: number;

  constructor(
    private readonly mod: EmscriptenModule,
    src: Uint8ClampedArray,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    options: WasmResizeOptions,
  ) {
    const srcBytes = srcW * srcH * 4;
    const srcPtr = mod._malloc(srcBytes);
    try {
      mod.HEAPU8.set(src.subarray(0, srcBytes), srcPtr);
      this.ctx = mod._resize_init(
        srcPtr, srcW, srcH, dstW, dstH,
        KERNEL_ID[options.kernel], options.sRGBGamma ? 1 : 0, options.gamma,
        options.coverageWeightedAlpha ? 1 : 0,
      );
    } finally {
      // init copies what it needs into its own buffers, so the staging copy frees now.
      mod._free(srcPtr);
    }
    if (!this.ctx) {
      throw new Error('resize_init failed (bad dimensions or allocation).');
    }
  }

  /** Resample one output tile rect into a fresh tile-sized RGBA buffer. */
  tile(ox0: number, oy0: number, ox1: number, oy1: number): Uint8ClampedArray<ArrayBuffer> {
    const bytes = (ox1 - ox0) * (oy1 - oy0) * 4;
    const tp = this.mod._malloc(bytes);
    try {
      if (!this.mod._resize_tile(this.ctx, ox0, oy0, ox1, oy1, tp)) {
        throw new Error('resize_tile failed.');
      }
      const out = new Uint8ClampedArray(bytes);
      out.set(this.mod.HEAPU8.subarray(tp, tp + bytes));
      return out;
    } finally {
      this.mod._free(tp);
    }
  }

  free(): void {
    if (this.ctx) {
      this.mod._resize_free(this.ctx);
      this.ctx = 0;
    }
  }
}
