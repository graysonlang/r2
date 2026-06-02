// Main-thread tile-pool client: a warm pool of source-resident workers that
// resample disjoint output tiles in parallel, reassembled into one image.
//
// Lifecycle per resize:
//   1. plan tiles on the main thread (prepareTiling) — also the single source of
//      truth for tile rects, shared with the workers via identical params.
//   2. broadcast `init` to every worker (a copy of the source each).
//   3. dispatch tile jobs: each idle worker pulls the next job; on result, blit
//      the tile into the destination and pull the next. Work-stealing by pull
//      naturally load-balances uneven tile cost (edge tiles differ).
//   4. resolve the full destination once every tile has landed.
//
// Header-free (no SharedArrayBuffer / COOP-COEP): the cost is one source copy per
// worker, paid once per resize. See src/worker/tileProtocol.ts.

import { prepareTiling, type ResizeSource, type SeparableOptions, type TileRect } from '../separable';
import type { TileInitParams, TileWorkerResponse } from './tileProtocol';

const COMPONENTS = 4;

export interface PoolOptions extends Partial<SeparableOptions> {
  tileSize?: number;
  /** Worker count; defaults to hardwareConcurrency (capped at the tile count). */
  workers?: number;
}

/**
 * Phase breakdown for one resize, in ms. `staging` = plan + per-worker source
 * copy + init dispatch; `parallel` = first tile dispatch until the last lands
 * (worker compute + transfers + interleaved main-thread blit); `blit` = the
 * cumulative main-thread blit CPU within that window (what SAB eliminates);
 * `tiles` = tile count; `total` = whole call. Pass an object to `resize` to fill.
 */
export interface PoolTimings {
  staging: number;
  parallel: number;
  blit: number;
  tiles: number;
  total: number;
}

export class ResizePool {
  private readonly workers: Worker[] = [];
  private readonly ready: Promise<void>;

  constructor(workerUrl: string | URL, count: number) {
    const readies: Promise<void>[] = [];
    for (let i = 0; i < count; ++i) {
      const worker = new Worker(workerUrl, { type: 'module' });
      this.workers.push(worker);
      readies.push(new Promise<void>((resolve) => {
        const onReady = (event: MessageEvent<TileWorkerResponse>) => {
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
   * Resize `src` to `dstWidth`x`dstHeight` across the pool. Plans tiles, inits
   * every worker with a copy of the source, dispatches tiles by idle-pull, and
   * blits results into one destination buffer. Resolves the full RGBA output.
   */
  async resize(
    src: ResizeSource,
    dstWidth: number,
    dstHeight: number,
    options: PoolOptions = {},
    timings?: PoolTimings,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    await this.ready;
    const tStart = performance.now();

    const tileSize = options.tileSize && options.tileSize > 0 ? options.tileSize : 512;
    // Plan on the main thread to get the tile list and validate; the workers
    // rebuild the identical plan from the same params.
    const plan = prepareTiling(src, dstWidth, dstHeight, tileSize, tileSize, options);
    const tiles = plan.tiles;

    const initParams: TileInitParams = {
      width: src.width,
      height: src.height,
      dstWidth,
      dstHeight,
      tileWidth: tileSize,
      tileHeight: tileSize,
      kernel: options.kernel ?? 'mitchell',
      coverageWeightedAlpha: plan.useCoverage,
    };
    // Init every worker with its own copy of the source (transferred).
    for (const worker of this.workers) {
      const copy = src.data.slice().buffer;
      worker.postMessage({ type: 'init', params: initParams, pixels: copy }, [copy]);
    }

    const dst = new Uint8ClampedArray(dstWidth * dstHeight * COMPONENTS);
    const dstStride = dstWidth * COMPONENTS;
    const tStaged = performance.now();
    let blitMs = 0;

    return new Promise<Uint8ClampedArray<ArrayBuffer>>((resolve, reject) => {
      let next = 0;
      let done = 0;
      // Per-worker listeners, removed on completion so repeated resize() calls
      // don't accumulate stale handlers.
      const listeners = new Map<Worker, (e: MessageEvent<TileWorkerResponse>) => void>();
      const cleanup = (): void => {
        for (const [worker, fn] of listeners) {
          worker.removeEventListener('message', fn as EventListener);
        }
        listeners.clear();
      };

      const blit = (rect: TileRect, pixels: Uint8ClampedArray): void => {
        const b0 = performance.now();
        const tileW = rect.ox1 - rect.ox0;
        for (let y = rect.oy0; y < rect.oy1; ++y) {
          const srcRow = (y - rect.oy0) * tileW * COMPONENTS;
          const dstRow = y * dstStride + rect.ox0 * COMPONENTS;
          dst.set(pixels.subarray(srcRow, srcRow + tileW * COMPONENTS), dstRow);
        }
        blitMs += performance.now() - b0;
      };

      const dispatch = (worker: Worker): void => {
        if (next >= tiles.length) {
          return;
        }
        const id = next++;
        worker.postMessage({ type: 'tile', id, rect: tiles[id] });
      };

      const onMessage = (worker: Worker, event: MessageEvent<TileWorkerResponse>): void => {
        const msg = event.data;
        if (msg.type === 'ready') {
          return;
        }
        if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message));
          return;
        }
        // tile result
        blit(msg.rect, new Uint8ClampedArray(msg.pixels));
        if (++done === tiles.length) {
          cleanup();
          if (timings) {
            const end = performance.now();
            timings.staging = tStaged - tStart;
            timings.parallel = end - tStaged;
            timings.blit = blitMs;
            timings.tiles = tiles.length;
            timings.total = end - tStart;
          }
          resolve(dst);
          return;
        }
        dispatch(worker); // pull the next job onto this now-idle worker
      };

      if (tiles.length === 0) {
        resolve(dst);
        return;
      }

      for (const worker of this.workers) {
        const fn = (e: MessageEvent<TileWorkerResponse>): void => onMessage(worker, e);
        listeners.set(worker, fn);
        worker.addEventListener('message', fn as EventListener);
      }
      // Prime: give each worker up to one in-flight job to start.
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
