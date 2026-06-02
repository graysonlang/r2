// Message protocol for the tile-pool worker (src/worker/tileWorker.ts).
//
// Model (decided 2026-05-31): source-resident persistent workers + tile-job
// dispatch. Each worker is sent a copy of the source once (`init`), builds its
// own weight tables, then answers `tile` jobs — resampling one output rect into a
// fresh tile buffer, transferred back. The main-thread pool (src/worker/pool.ts)
// load-balances jobs across workers by idle-pull and blits results into place.
// Header-free: no SharedArrayBuffer / COOP-COEP needed.

import type { KernelName } from '../separable';
import type { TileRect } from '../separable';

export interface TileInitParams {
  readonly width: number;
  readonly height: number;
  readonly dstWidth: number;
  readonly dstHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly kernel: KernelName;
  readonly coverageWeightedAlpha: boolean;
}

// --- Main thread -> worker ---

// Install the source + build the tiling plan. `pixels` is a per-worker copy of
// the source, transferred (the pool slices a copy for each worker).
export interface TileInitRequest {
  readonly type: 'init';
  readonly params: TileInitParams;
  readonly pixels: ArrayBuffer;
}

// Resample one output tile. `id` matches the response.
export interface TileJobRequest {
  readonly type: 'tile';
  readonly id: number;
  readonly rect: TileRect;
}

export type TileWorkerRequest = TileInitRequest | TileJobRequest;

// --- Worker -> main thread ---

export interface TileReadyMessage {
  readonly type: 'ready';
}

// Result for tile `id`: the tile's RGBA pixels (rect width x height), transferred.
export interface TileResultMessage {
  readonly type: 'tile';
  readonly id: number;
  readonly rect: TileRect;
  readonly pixels: ArrayBuffer;
}

export interface TileErrorMessage {
  readonly type: 'error';
  readonly id: number;
  readonly message: string;
}

export type TileWorkerResponse = TileReadyMessage | TileResultMessage | TileErrorMessage;
