// Resize worker.
//
// Establishes the message protocol and lifecycle for the Phase-3 resizer and
// runs the actual resample. The kernel is currently the TS reference resampler
// (src/separable.ts) executed in the worker; the Wasm/SIMD Lanczos-2 kernel
// drops in behind this same protocol later. See src/worker/protocol.ts.

/// <reference lib="webworker" />

import { resizeSeparable, resizeSeparableTiled, resizeThumbnail } from '../separable';
import { loadResizeWasm, resizeWasm } from '../wasm/resizeWasm';
import type { DecodeResizeRequest, ResizeRequest, WorkerRequest, WorkerResponse } from './protocol';

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

async function handleResize(request: ResizeRequest): Promise<void> {
  const { id, params, pixels } = request;
  const { width, height, dstWidth, dstHeight, kernel, coverageWeightedAlpha, tileSize, engine } = params;

  if (pixels.byteLength < width * height * 4) {
    post({ type: 'error', id, message: 'Source buffer too small for dimensions.' });
    return;
  }

  try {
    const data = new Uint8ClampedArray(pixels);
    const opts = { kernel, coverageWeightedAlpha };
    let out: Uint8ClampedArray<ArrayBuffer>;
    if (engine === 'wasm') {
      const mod = await loadResizeWasm();
      out = resizeWasm(mod, data, width, height, dstWidth, dstHeight, {
        kernel, coverageWeightedAlpha, sRGBGamma: true, gamma: 2.2,
      });
    } else {
      const src = { data, width, height };
      // Pure separable Lanczos cost is dominated by the horizontal pass reading
      // every SOURCE pixel (taps grow as scale shrinks → cost plateaus at heavy
      // downscale, not falling with output size). At >=4x/axis, shrink-then-reduce
      // is well past its crossover (measured ~1.6x@4x, 2.4x@8x) so route there —
      // it's a ~6 LSB approximation, so only for big reductions, and only the
      // whole-image path (tiled stays bit-identical for the pool).
      // Precedence: heavy-downscale shrink-then-reduce wins even when tiling is
      // on. They're complementary (shrink cuts compute, tiling bounds memory), but
      // at >=4x the shrink collapses the source ~k²× so the residual is small and
      // the per-pull tiling benefit is marginal; the shrink is the dominant win.
      // (~6 LSB approximation, so heavy ratios only; the bit-identical pool path
      // uses resizeTileRegion directly, unaffected.)
      const heavyDownscale = width >= dstWidth * 4 && height >= dstHeight * 4;
      if (heavyDownscale) {
        out = resizeThumbnail(src, dstWidth, dstHeight, opts);
      } else if (tileSize && tileSize > 0) {
        out = resizeSeparableTiled(src, dstWidth, dstHeight, tileSize, tileSize, opts);
      } else {
        out = resizeSeparable(src, dstWidth, dstHeight, opts);
      }
    }
    post({ type: 'result', id, params, pixels: out.buffer, dstWidth, dstHeight }, [out.buffer]);
  } catch (error) {
    post({ type: 'error', id, message: (error as Error).message });
  }
}

// Decode the Blob in the worker (createImageBitmap + OffscreenCanvas), off the
// main thread (spec §7.4), then resize. Uses shrink-then-reduce since the
// file→thumbnail case is the large-downscale regime this is built for.
async function handleDecodeResize(request: DecodeResizeRequest): Promise<void> {
  const { id, params, blob } = request;
  const { dstWidth, dstHeight, kernel, coverageWeightedAlpha } = params;

  try {
    const bitmap = await createImageBitmap(blob);
    const sw = bitmap.width;
    const sh = bitmap.height;
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) {
      throw new Error('OffscreenCanvas 2D context unavailable.');
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const decoded = ctx.getImageData(0, 0, sw, sh);

    const src = { data: decoded.data, width: sw, height: sh };
    // Clamp dst to the decoded size (can't upscale); the resampler requires >=3px.
    const dw = Math.max(3, Math.min(dstWidth, sw));
    const dh = Math.max(3, Math.min(dstHeight, sh));
    const out = resizeThumbnail(src, dw, dh, { kernel, coverageWeightedAlpha });
    post({ type: 'result', id, params, pixels: out.buffer, dstWidth: dw, dstHeight: dh }, [out.buffer]);
  } catch (error) {
    post({ type: 'error', id, message: (error as Error).message });
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'resize') {
    void handleResize(message);
  } else if (message.type === 'decodeResize') {
    void handleDecodeResize(message);
  }
});

// Handshake: announce readiness only after the handler above is installed.
post({ type: 'ready' });
