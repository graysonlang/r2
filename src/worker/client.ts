// Main-thread client for the resize worker: spawns it, waits for the `ready`
// handshake, and exposes a promise-based `resize()` that matches responses to
// requests by id. One request in flight per id; the source buffer is transferred
// to the worker and the result buffer transferred back.

import type { ResizeParams, WorkerRequest, WorkerResponse } from './protocol';
import {
  DEFAULT_RESPAWN,
  estimatedGrowthMB,
  newUsage,
  recordJob,
  type RespawnConfig,
  shouldRespawn,
  type WorkerUsage,
} from './respawnPolicy';

/** Result of a resize: the pixels plus the actual output dimensions. */
export interface ResizeResultData {
  pixels: Uint8ClampedArray;
  dstWidth: number;
  dstHeight: number;
}

export class ResizeClient {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (result: ResizeResultData) => void;
    reject: (error: Error) => void;
  }>();

  constructor(workerUrl: string | URL) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.ready = new Promise<void>((resolve) => {
      const onReady = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === 'ready') {
          this.worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      this.worker.addEventListener('message', onReady);
    });
    this.worker.addEventListener('message', e => this.onMessage(e));
  }

  private onMessage(event: MessageEvent<WorkerResponse>): void {
    const message = event.data;
    if (message.type === 'ready') {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    if (message.type === 'error') {
      entry.reject(new Error(message.message));
    } else {
      entry.resolve({
        pixels: new Uint8ClampedArray(message.pixels),
        dstWidth: message.dstWidth,
        dstHeight: message.dstHeight,
      });
    }
  }

  /** Resolve once the worker has signalled it is ready to accept requests. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Resize `pixels` (straight-alpha RGBA, `width`x`height`) to `dstWidth`x
   * `dstHeight`. The input buffer is transferred to the worker (consumed); the
   * resolved buffer is the transferred-back result.
   */
  async resize(
    pixels: Uint8ClampedArray,
    params: ResizeParams,
  ): Promise<ResizeResultData> {
    await this.ready;
    const id = this.nextId++;
    // Copy into a standalone buffer to transfer (the caller's view may be a
    // slice of a larger ImageData buffer that we must not detach).
    const buffer = pixels.slice().buffer;
    const request: WorkerRequest = { type: 'resize', id, params, pixels: buffer };
    return new Promise<ResizeResultData>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request, [buffer]);
    });
  }

  /**
   * Decode `blob` and resize it entirely in the worker (off the main thread). The
   * `width`/`height` in `params` are ignored — decode determines source size; the
   * resolved result carries the actual output dimensions.
   */
  async decodeResize(blob: Blob, params: ResizeParams): Promise<ResizeResultData> {
    await this.ready;
    const id = this.nextId++;
    const request: WorkerRequest = { type: 'decodeResize', id, params, blob };
    return new Promise<ResizeResultData>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Worker terminated.'));
    }
    this.pending.clear();
  }
}

/**
 * A persistent {@link ResizeClient} that recycles its worker when a high-water
 * mark is crossed — the memory-hygiene strategy for a long-lived session (plan
 * §11). Requests are serialized (one in flight) so the recycle, decided after each
 * completed job via {@link shouldRespawn}, always happens between jobs, never
 * mid-flight. `terminate()` drops the whole worker heap (incl. Wasm linear memory)
 * back to the OS — the reclamation the incumbent long-lived service lacks.
 */
export class ManagedResizeClient {
  private client: ResizeClient;
  private usage: WorkerUsage = newUsage();
  private chain: Promise<unknown> = Promise.resolve();
  private respawns = 0;

  constructor(
    private readonly workerUrl: string | URL,
    private readonly config: RespawnConfig = DEFAULT_RESPAWN,
    private readonly spawn: (url: string | URL) => ResizeClient = url => new ResizeClient(url),
  ) {
    this.client = this.spawn(workerUrl);
  }

  /** Number of times the worker has been recycled (for instrumentation/tests). */
  get respawnCount(): number {
    return this.respawns;
  }

  /** Estimated RSS growth (MB) accrued by the current worker (work proxy). */
  get estimatedGrowthMB(): number {
    return estimatedGrowthMB(this.usage);
  }

  whenReady(): Promise<void> {
    return this.client.whenReady();
  }

  resize(pixels: Uint8ClampedArray, params: ResizeParams): Promise<ResizeResultData> {
    return this.run(c => c.resize(pixels, params));
  }

  decodeResize(blob: Blob, params: ResizeParams): Promise<ResizeResultData> {
    return this.run(c => c.decodeResize(blob, params));
  }

  // Serialize all work through one chain so respawn never races an in-flight job.
  private run(op: (c: ResizeClient) => Promise<ResizeResultData>): Promise<ResizeResultData> {
    const next = this.chain.then(async () => {
      const result = await op(this.client);
      recordJob(this.usage, result.dstWidth, result.dstHeight);
      if (shouldRespawn(this.usage, this.config)) {
        this.recycle();
      }
      return result;
    });
    // Keep the chain alive even if a job rejects (don't wedge the queue).
    this.chain = next.catch(() => undefined);
    return next;
  }

  private recycle(): void {
    this.client.terminate();
    this.client = this.spawn(this.workerUrl);
    this.usage = newUsage();
    this.respawns += 1;
  }

  terminate(): void {
    this.client.terminate();
  }
}
