// Tile-pool worker: source-resident, answers per-tile resample jobs.
//
// On `init` it keeps a copy of the source and builds the tiling plan (global
// weight tables + tile list) once; each `tile` job resamples one output rect via
// resizeTileRegion and transfers the tile buffer back. Currently runs the TS
// kernel (bit-identical to the oracle); a Wasm tile path can drop in behind the
// same protocol later. See src/worker/tileProtocol.ts.

/// <reference lib="webworker" />

import { prepareTiling, resizeTileRegion, type TilingPlan } from '../separable';
import type { TileWorkerRequest, TileWorkerResponse } from './tileProtocol';

function post(message: TileWorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

let plan: TilingPlan | null = null;

self.addEventListener('message', (event: MessageEvent<TileWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    const { params, pixels } = message;
    const src = { data: new Uint8ClampedArray(pixels), width: params.width, height: params.height };
    plan = prepareTiling(src, params.dstWidth, params.dstHeight, params.tileWidth, params.tileHeight, {
      kernel: params.kernel,
      coverageWeightedAlpha: params.coverageWeightedAlpha,
    });
    return;
  }

  // tile job
  const { id, rect } = message;
  if (!plan) {
    post({ type: 'error', id, message: 'Tile job before init.' });
    return;
  }
  try {
    const tile = resizeTileRegion(plan, rect);
    post({ type: 'tile', id, rect, pixels: tile.buffer }, [tile.buffer]);
  } catch (error) {
    post({ type: 'error', id, message: (error as Error).message });
  }
});

// Handshake: announce readiness only after the handler above is installed.
post({ type: 'ready' });
