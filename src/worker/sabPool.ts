// Main-thread SAB tile-pool client. The fastest buffer strategy (spec §3.3):
// source and output both live in SharedArrayBuffers, so there is no per-worker
// source copy and no per-tile result transfer/blit — workers read the shared
// source and write resampled tiles directly into the shared output.
//
// Lifecycle per resize:
//   1. copy the source into a shared source SAB once; allocate a shared output SAB.
//   2. broadcast `init` (SABs by reference — not transferred) to all workers.
//   3. plan tiles, dispatch by idle-pull; workers write tiles in place and reply
//      `done` (id only). Resolve a view over the shared output when all land.
//
// Requires cross-origin isolation (crossOriginIsolated) — see scripts/serve-sab.mjs.
// `ResizePool.isSupported()` gates use; the demo falls back when unsupported.

import { prepareTiling, type ResizeSource, type SeparableOptions } from '../separable';
import type { PoolTimings } from './pool';
import type { SabInitParams, SabWorkerResponse } from './sabProtocol';

const COMPONENTS = 4;

export interface SabPoolOptions extends Partial<SeparableOptions> {
  tileSize?: number;
}

export class SabResizePool {
  private readonly workers: Worker[] = [];
  private readonly ready: Promise<void>;

  /** SAB requires cross-origin isolation; check before constructing. */
  static isSupported(): boolean {
    return typeof SharedArrayBuffer !== 'undefined'
      && typeof globalThis.crossOriginIsolated !== 'undefined'
      && globalThis.crossOriginIsolated === true;
  }

  constructor(workerUrl: string | URL, count: number) {
    const readies: Promise<void>[] = [];
    for (let i = 0; i < count; ++i) {
      const worker = new Worker(workerUrl, { type: 'module' });
      this.workers.push(worker);
      readies.push(new Promise<void>((resolve) => {
        const onReady = (event: MessageEvent<SabWorkerResponse>) => {
          if (event.data.type === 'ready') {
            worker.removeEventListener('message', onReady);
            resolve();
          }
        };
        worker.addEventListener('message', onReady);
      }));
    }
    this.ready = Promise.all(readies).then(() => undefined);
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  get size(): number {
    return this.workers.length;
  }

  /**
   * Resize `src` to `dstWidth`x`dstHeight` across the pool using shared source +
   * output SABs. Resolves a fresh (non-shared) RGBA copy of the result.
   */
  async resize(
    src: ResizeSource,
    dstWidth: number,
    dstHeight: number,
    options: SabPoolOptions = {},
    timings?: PoolTimings,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    await this.ready;
    const tStart = performance.now();

    const tileSize = options.tileSize && options.tileSize > 0 ? options.tileSize : 512;
    const plan = prepareTiling(src, dstWidth, dstHeight, tileSize, tileSize, options);
    const tiles = plan.tiles;

    // Shared source: copy the source bytes in once; all workers read it.
    const srcBytes = src.width * src.height * COMPONENTS;
    const source = new SharedArrayBuffer(srcBytes);
    new Uint8ClampedArray(source).set(src.data.subarray(0, srcBytes));

    // Shared output: workers write disjoint tile rects directly into it.
    const output = new SharedArrayBuffer(dstWidth * dstHeight * COMPONENTS);

    const initParams: SabInitParams = {
      srcWidth: src.width,
      srcHeight: src.height,
      dstWidth,
      dstHeight,
      kernel: options.kernel ?? 'mitchell',
      coverageWeightedAlpha: plan.useCoverage,
    };
    for (const worker of this.workers) {
      worker.postMessage({ type: 'init', params: initParams, source, output });
    }
    const tStaged = performance.now();

    return new Promise<Uint8ClampedArray<ArrayBuffer>>((resolve, reject) => {
      let next = 0;
      let done = 0;
      const listeners = new Map<Worker, (e: MessageEvent<SabWorkerResponse>) => void>();
      const cleanup = (): void => {
        for (const [worker, fn] of listeners) {
          worker.removeEventListener('message', fn as EventListener);
        }
        listeners.clear();
      };

      const dispatch = (worker: Worker): void => {
        if (next >= tiles.length) {
          return;
        }
        const id = next++;
        worker.postMessage({ type: 'tile', id, rect: tiles[id] });
      };

      const onMessage = (worker: Worker, event: MessageEvent<SabWorkerResponse>): void => {
        const msg = event.data;
        if (msg.type === 'ready') {
          return;
        }
        if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message));
          return;
        }
        // done — the tile is already in the shared output.
        if (++done === tiles.length) {
          cleanup();
          const tCompute = performance.now();
          // Copy out of the SAB into a regular buffer for the caller / canvas.
          const out = new Uint8ClampedArray(dstWidth * dstHeight * COMPONENTS);
          out.set(new Uint8ClampedArray(output));
          const end = performance.now();
          if (timings) {
            timings.staging = tStaged - tStart;
            timings.parallel = tCompute - tStaged;
            timings.blit = end - tCompute; // the single shared-output copy-out
            timings.tiles = tiles.length;
            timings.total = end - tStart;
          }
          resolve(out);
          return;
        }
        dispatch(worker);
      };

      if (tiles.length === 0) {
        resolve(new Uint8ClampedArray(dstWidth * dstHeight * COMPONENTS));
        return;
      }
      for (const worker of this.workers) {
        const fn = (e: MessageEvent<SabWorkerResponse>): void => onMessage(worker, e);
        listeners.set(worker, fn);
        worker.addEventListener('message', fn as EventListener);
      }
      for (const worker of this.workers) {
        dispatch(worker);
      }
    });
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers.length = 0;
  }
}
