// Message protocol between the main thread and the resize worker.
//
// The worker posts `ready` once its message handler is installed (the handshake
// that avoids the module-worker dropped-message race), then answers each
// `resize` request with a matching `result` (or `error`) carrying the same id.
//
// This is the Phase-3 worker boundary. The kernel behind it currently runs the
// TS reference resampler (src/separable.ts) inside the worker; the Wasm/SIMD
// Lanczos-2 kernel drops in behind this same protocol later — see
// tiled-scaler-plan.md.

import type { KernelName } from '../separable';

/** Which resampler implementation the worker should run. */
export type ResizeEngine = 'ts' | 'wasm';

export interface ResizeParams {
  readonly width: number;
  readonly height: number;
  readonly dstWidth: number;
  readonly dstHeight: number;
  readonly kernel: KernelName;
  readonly coverageWeightedAlpha: boolean;
  /**
   * Output tile size for the in-worker tiled resampler. 0 (or omitted) resizes
   * the whole image in one pass. Any positive size yields bit-identical output —
   * tiling is a cache/memory decomposition, not a quality knob. (TS engine only;
   * the Wasm kernel is whole-image until its own tiling lands.)
   */
  readonly tileSize?: number;
  /** Resampler implementation; defaults to 'ts' when omitted. */
  readonly engine?: ResizeEngine;
}

// --- Main thread -> worker ---

export interface ResizeRequest {
  readonly type: 'resize';
  readonly id: number;
  readonly params: ResizeParams;
  /** Straight-alpha 8-bit RGBA source pixels. Transferred (not copied). */
  readonly pixels: ArrayBuffer;
}

/**
 * Decode + resize a file in the worker: hand it the encoded bytes (Blob) and the
 * worker decodes via `createImageBitmap` + OffscreenCanvas (off the main thread —
 * the spec §7.4 path), then resizes. `width`/`height` of {@link ResizeParams} are
 * ignored (decode determines them); the rest (dst size, kernel, …) apply. For
 * large downscales the worker uses shrink-then-reduce.
 */
export interface DecodeResizeRequest {
  readonly type: 'decodeResize';
  readonly id: number;
  readonly params: ResizeParams;
  /** Encoded image bytes (PNG/JPEG/…). Structured-cloned to the worker. */
  readonly blob: Blob;
}

export type WorkerRequest = ResizeRequest | DecodeResizeRequest;

// --- Worker -> main thread ---

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface ResizeResult {
  readonly type: 'result';
  readonly id: number;
  readonly params: ResizeParams;
  /** Straight-alpha 8-bit RGBA destination pixels. Transferred back. */
  readonly pixels: ArrayBuffer;
  /** Output dimensions (so decodeResize callers learn the dst size). */
  readonly dstWidth: number;
  readonly dstHeight: number;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly id: number;
  readonly message: string;
}

export type WorkerResponse = ReadyMessage | ResizeResult | ErrorMessage;
