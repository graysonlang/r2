// Wasm tile-pool worker: same protocol as tileWorker.ts, but each tile is
// resampled by the SIMD Wasm kernel via a source-resident WasmTileContext
// (resize_init once, resize_tile per job). Pairs the ~3x pool parallelism with
// the ~1.6-1.9x Wasm kernel. See src/worker/tileProtocol.ts.

/// <reference lib="webworker" />

import { loadResizeWasm, WasmTileContext } from '../wasm/resizeWasm';
import type { TileWorkerRequest, TileWorkerResponse } from './tileProtocol';

function post(message: TileWorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

// The context is built asynchronously (wasm load + init), but the pool dispatches
// tile jobs immediately after init — so jobs await this promise rather than a
// possibly-not-yet-built context. Messages arrive in order, so `init` sets this
// before any `tile` reads it.
let contextPromise: Promise<WasmTileContext> | null = null;

self.addEventListener('message', (event: MessageEvent<TileWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'init') {
    const { params, pixels } = message;
    // The module is cached across inits; build a fresh context per source.
    const prev = contextPromise;
    contextPromise = loadResizeWasm().then(async (mod) => {
      (await prev?.catch(() => null))?.free();
      return new WasmTileContext(
        mod, new Uint8ClampedArray(pixels), params.width, params.height,
        params.dstWidth, params.dstHeight,
        {
          kernel: params.kernel,
          sRGBGamma: true,
          gamma: 2.2,
          coverageWeightedAlpha: params.coverageWeightedAlpha,
        },
      );
    });
    return;
  }

  // tile job — await the context (built by the preceding init).
  const { id, rect } = message;
  if (!contextPromise) {
    post({ type: 'error', id, message: 'Tile job before init.' });
    return;
  }
  void contextPromise.then((context) => {
    const tile = context.tile(rect.ox0, rect.oy0, rect.ox1, rect.oy1);
    post({ type: 'tile', id, rect, pixels: tile.buffer }, [tile.buffer]);
  }).catch((error: unknown) => {
    post({ type: 'error', id, message: (error as Error).message });
  });
});

// Handshake: announce readiness only after the handler above is installed.
post({ type: 'ready' });
