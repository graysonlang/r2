// SAB tile-pool worker: reads a shared source, writes tiles directly into a
// shared output. No per-tile transfers, no main-thread blit — the worker's
// vertical pass writes resampled pixels straight into the shared destination at
// the tile's position. Tiles are disjoint, so no locking. Runs the TS kernel
// (bit-identical to the oracle). See src/worker/sabProtocol.ts.

/// <reference lib="webworker" />

import { prepareTiling, resizeTileRegionInto, type TilingPlan } from '../separable';
import type { SabWorkerRequest, SabWorkerResponse } from './sabProtocol';

function post(message: SabWorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

let plan: TilingPlan | null = null;
// View over the shared output buffer; tiles are written here in place.
let output: Uint8ClampedArray | null = null;

self.addEventListener('message', (event: MessageEvent<SabWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    const { params, source, output: out } = message;
    // Map the shared buffers as views — NO copy. Every worker sees the same bytes.
    const srcView = new Uint8ClampedArray(source, 0, params.srcWidth * params.srcHeight * 4);
    const src = { data: srcView, width: params.srcWidth, height: params.srcHeight };
    plan = prepareTiling(src, params.dstWidth, params.dstHeight, params.dstWidth, params.dstHeight, {
      kernel: params.kernel,
      coverageWeightedAlpha: params.coverageWeightedAlpha,
    });
    output = new Uint8ClampedArray(out, 0, params.dstWidth * params.dstHeight * 4);
    return;
  }

  // tile job — resample directly into the shared output, reply with just the id.
  const { id, rect } = message;
  if (!plan || !output) {
    post({ type: 'error', id, message: 'Tile job before init.' });
    return;
  }
  try {
    resizeTileRegionInto(plan, rect, output);
    post({ type: 'done', id });
  } catch (error) {
    post({ type: 'error', id, message: (error as Error).message });
  }
});

// Handshake: announce readiness only after the handler above is installed.
post({ type: 'ready' });
