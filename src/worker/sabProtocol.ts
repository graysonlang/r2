// Message protocol for the SAB (SharedArrayBuffer) worker pool.
//
// Buffer strategy (spec §3.3, fastest path): both the source and the output live
// in SharedArrayBuffers shared with every worker. On `init` each worker maps the
// shared source (no copy) and builds its tiling context. Each `tile` job names an
// output rect; the worker resamples it and writes the pixels DIRECTLY into the
// shared output at the rect's destination offset — no per-tile transfer, no
// main-thread blit. Tiles are disjoint by construction, so no locking is needed;
// the worker only signals completion (an id, no payload).
//
// Requires cross-origin isolation (COOP/COEP) — see scripts/serve-sab.mjs.

import type { KernelName, TileRect } from '../separable';

export interface SabInitParams {
  readonly srcWidth: number;
  readonly srcHeight: number;
  readonly dstWidth: number;
  readonly dstHeight: number;
  readonly kernel: KernelName;
  readonly coverageWeightedAlpha: boolean;
}

// --- Main thread -> worker ---

// Map the shared source + output and build the tiling context. The SABs are
// shared (passed by reference in the message — NOT transferred), so every worker
// sees the same memory.
export interface SabInitRequest {
  readonly type: 'init';
  readonly params: SabInitParams;
  readonly source: SharedArrayBuffer;
  readonly output: SharedArrayBuffer;
}

// Resample one output tile and write it into the shared output. `id` matches the
// done reply.
export interface SabJobRequest {
  readonly type: 'tile';
  readonly id: number;
  readonly rect: TileRect;
}

export type SabWorkerRequest = SabInitRequest | SabJobRequest;

// --- Worker -> main thread ---

export interface SabReadyMessage {
  readonly type: 'ready';
}

// Tile `id` is finished and already written into the shared output — no payload.
export interface SabDoneMessage {
  readonly type: 'done';
  readonly id: number;
}

export interface SabErrorMessage {
  readonly type: 'error';
  readonly id: number;
  readonly message: string;
}

export type SabWorkerResponse = SabReadyMessage | SabDoneMessage | SabErrorMessage;
