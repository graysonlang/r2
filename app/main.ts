import { getImageData, loadImage } from '../src/canvasUtils';
import type { KernelName } from '../src/separable';
import { SYNTHETIC_SOURCES } from '../src/synthetic';
import { ResizeClient } from '../src/worker/client';
import { ResizePool } from '../src/worker/pool';
import { SabResizePool } from '../src/worker/sabPool';
import { chooseStrategy } from '../src/worker/strategy';

// Importing the page keeps esbuild from stripping it and ensures esp copies it
// to the output directory as the served entry document.
import indexHtml from './index.html';
export const filePaths = { index: indexHtml };

// Workers are their own build entry points; esbuild emits them next to this
// bundle. Reference by built filename (esbuild 0.28 does not auto-bundle
// `new Worker(new URL(...))`).
const WORKER_URL = './resizeWorker.js';
const TILE_WORKER_URL = './tileWorker.js';
const WASM_TILE_WORKER_URL = './wasmTileWorker.js';
const SAB_WORKER_URL = './sabWorker.js';

const IMAGE_DIR = 'assets/';

// Selectable sources: file-backed assets plus runtime-generated synthetic ones.
// Synthetic sources take the chosen Size; files ignore it. `id` is the stable
// value used in the dropdown and the `img` query param.
type Source
  = | { id: string; label: string; kind: 'file'; file: string }
    | { id: string; label: string; kind: 'synthetic'; key: string };

const SOURCES: Source[] = [
  { id: 'test_card.png', label: 'test_card.png', kind: 'file', file: 'test_card.png' },
  { id: 'zone_plate.png', label: 'zone_plate.png', kind: 'file', file: 'zone_plate.png' },
  { id: 'star.png', label: 'star.png', kind: 'file', file: 'star.png' },
  { id: 'grid_spectrum.png', label: 'grid_spectrum.png', kind: 'file', file: 'grid_spectrum.png' },
  { id: '3D.png', label: '3D.png', kind: 'file', file: '3D.png' },
  { id: 'picker.png', label: 'picker.png', kind: 'file', file: 'picker.png' },
  { id: 'alpha_fringe.png', label: 'alpha_fringe.png', kind: 'file', file: 'alpha_fringe.png' },
  ...Object.entries(SYNTHETIC_SOURCES).map(([key, s]): Source => ({
    id: `gen:${key}`, label: `${s.label} (generated)`, kind: 'synthetic', key,
  })),
];

// Control defaults (mirror the values in index.html). Params equal to these are
// omitted from the URL so a pristine view has a clean address.
const DEFAULT_SCALE = '0.65';
const DEFAULT_KERNEL = 'lanczos2';
const DEFAULT_TILE = '256';
const DEFAULT_SIZE = '4096';
// Auto (TS) is the default: runs the shared routing policy (inline/shrink/pool)
// per the measured thresholds (src/worker/strategy.ts), zero server config.
const DEFAULT_ENGINE = 'auto-ts';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}

// Resolve the initial source index from the `img` query param, falling back to
// the first source when it's missing or unrecognized.
function indexFromUrl(): number {
  const name = new URLSearchParams(window.location.search).get('img');
  const i = name === null ? -1 : SOURCES.findIndex(s => s.id === name);
  return i >= 0 ? i : 0;
}

window.addEventListener('load', () => {
  const imageSelect = requireElement<HTMLSelectElement>('image-select');
  const prevButton = requireElement<HTMLButtonElement>('prev-image');
  const nextButton = requireElement<HTMLButtonElement>('next-image');
  const scaleNumber = requireElement<HTMLInputElement>('scale-number');
  const scaleRange = requireElement<HTMLInputElement>('scale-range');
  const engineSelect = requireElement<HTMLSelectElement>('engine');
  const kernelSelect = requireElement<HTMLSelectElement>('kernel');
  const tileSelect = requireElement<HTMLSelectElement>('tile');
  const sizeSelect = requireElement<HTMLSelectElement>('size');
  const status = requireElement<HTMLElement>('status');
  const workerCanvas = requireElement<HTMLCanvasElement>('canvas-worker');

  for (const [i, source] of SOURCES.entries()) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = source.label;
    imageSelect.appendChild(option);
  }

  // Apply control query params over the markup defaults; `img` is handled
  // separately by indexFromUrl() / selectImage().
  const params = new URLSearchParams(window.location.search);
  const scaleParam = params.get('scale');
  if (scaleParam !== null && Number.isFinite(parseFloat(scaleParam))) {
    scaleNumber.value = scaleParam;
    scaleRange.value = scaleParam;
  }
  // Start from the measured default (markup lists 'ts' first); URL param overrides.
  engineSelect.value = DEFAULT_ENGINE;
  const engineParam = params.get('engine');
  if (engineParam !== null && [...engineSelect.options].some(o => o.value === engineParam)) {
    engineSelect.value = engineParam;
  }
  const kernelParam = params.get('kernel');
  if (kernelParam !== null && [...kernelSelect.options].some(o => o.value === kernelParam)) {
    kernelSelect.value = kernelParam;
  }
  // Tile select starts at the markup default (whole image); apply DEFAULT_TILE,
  // then the URL param if present and valid.
  tileSelect.value = DEFAULT_TILE;
  const tileParam = params.get('tile');
  if (tileParam !== null && [...tileSelect.options].some(o => o.value === tileParam)) {
    tileSelect.value = tileParam;
  }
  sizeSelect.value = DEFAULT_SIZE;
  const sizeParam = params.get('size');
  if (sizeParam !== null && [...sizeSelect.options].some(o => o.value === sizeParam)) {
    sizeSelect.value = sizeParam;
  }

  const client = new ResizeClient(WORKER_URL);
  void client.whenReady().then(() => {
    status.textContent = 'worker ready';
  });

  // Pools are created lazily on first use (each spawns N tile workers). One per
  // engine — TS tile workers vs Wasm tile workers — behind the same protocol.
  // Sweet spot from the sweep is workers = hardwareConcurrency (oversubscription
  // hurts, undersubscription leaves cores idle). No artificial cap — staging cost
  // doesn't scale with worker count on the pool engines that matter here.
  const poolSize = Math.max(2, navigator.hardwareConcurrency || 4);
  const pools: Partial<Record<'pool' | 'wasm-pool', ResizePool>> = {};
  function getPool(engine: 'pool' | 'wasm-pool'): ResizePool {
    return (pools[engine] ??= new ResizePool(
      engine === 'wasm-pool' ? WASM_TILE_WORKER_URL : TILE_WORKER_URL, poolSize));
  }

  // The SAB pool needs cross-origin isolation (COOP/COEP). Lazy + gated.
  let sabPool: SabResizePool | null = null;
  function getSabPool(): SabResizePool {
    return (sabPool ??= new SabResizePool(SAB_WORKER_URL, poolSize));
  }

  let currentIndex = 0;
  // The current source's decoded/generated pixels (ImageData), or null until ready.
  let srcData: ImageData | null = null;

  // Write current state into the URL as query params, omitting any that equal
  // their default (so a pristine view is a clean address). replaceState keeps it
  // out of history so a reload restores the view without spamming back entries.
  function syncUrl(): void {
    const search = new URLSearchParams();
    if (currentIndex !== 0) {
      search.set('img', SOURCES[currentIndex].id);
    }
    if (scaleNumber.value !== DEFAULT_SCALE) {
      search.set('scale', scaleNumber.value);
    }
    if (engineSelect.value !== DEFAULT_ENGINE) {
      search.set('engine', engineSelect.value);
    }
    if (kernelSelect.value !== DEFAULT_KERNEL) {
      search.set('kernel', kernelSelect.value);
    }
    if (tileSelect.value !== DEFAULT_TILE) {
      search.set('tile', tileSelect.value);
    }
    // Size only matters for synthetic sources.
    if (SOURCES[currentIndex].kind === 'synthetic' && sizeSelect.value !== DEFAULT_SIZE) {
      search.set('size', sizeSelect.value);
    }
    const query = search.toString();
    history.replaceState(null, '', query ? '?' + query : window.location.pathname);
  }

  function paint(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, w: number, h: number): void {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    if (!ctx) {
      throw new Error('Unable to acquire a 2D canvas context.');
    }
    // Copy into an ArrayBuffer-backed view (ImageData rejects SharedArrayBuffer-backed).
    const view = new Uint8ClampedArray(w * h * 4);
    view.set(pixels.subarray(0, view.length));
    ctx.putImageData(new ImageData(view, w, h, { colorSpace: 'display-p3' }), 0, 0);
  }

  // Coalesce resize requests: at most one in flight, at most one queued. While a
  // request runs, further calls just mark `pending`; when it finishes we run once
  // more, picking up the latest control values (latest-wins, intermediate drops
  // coalesced away). This keeps a dragged slider from flooding the worker.
  //
  // DEMO-ONLY: this is a UI affordance for the interactive slider, not part of
  // the resize contract — it lives in the demo shell, not in ResizeClient /
  // protocol / worker. The intended app (drag-and-drop import) resizes each asset
  // once to a fixed target, so it never hits this. The real Wasm worker will
  // instead need true *cancellation* (user-abort of an in-flight resize), which
  // is a different mechanism from this coalescing — see protocol cancel message.
  let busy = false;
  let pending = false;

  function refreshOutput(): void {
    if (busy) {
      pending = true;
      return;
    }
    void runResize();
  }

  async function runResize(): Promise<void> {
    if (!srcData) {
      return;
    }
    busy = true;
    pending = false;

    const src = srcData;
    const scale = parseFloat(scaleNumber.value);
    const dstWidth = Math.max(3, Math.floor(src.width * scale));
    const dstHeight = Math.max(3, Math.floor(src.height * scale));

    const tileSize = Number(tileSelect.value);
    const engine = engineSelect.value;
    const kernel = kernelSelect.value as KernelName;

    status.textContent = 'resizing…';
    const t0 = performance.now();
    try {
      // Browser baseline: the canvas's own high-quality drawImage downscale
      // (main-thread, GPU-assisted, non-linear sRGB). Different shape — it draws
      // straight to the canvas, no pixel buffer — so it's handled and timed here.
      // Note it resamples in gamma space (not linear), so quality differs; this is
      // the implicit baseline every other engine competes with.
      if (engine === 'browser') {
        const srcCanvas = new OffscreenCanvas(src.width, src.height);
        const sctx = srcCanvas.getContext('2d', { colorSpace: 'display-p3' });
        if (!sctx) {
          throw new Error('OffscreenCanvas 2D context unavailable.');
        }
        sctx.putImageData(src, 0, 0);
        workerCanvas.width = dstWidth;
        workerCanvas.height = dstHeight;
        const dctx = workerCanvas.getContext('2d', { colorSpace: 'display-p3' });
        if (!dctx) {
          throw new Error('Unable to acquire a 2D canvas context.');
        }
        dctx.imageSmoothingEnabled = true;
        dctx.imageSmoothingQuality = 'high';
        dctx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);
        const dt = (performance.now() - t0).toFixed(1);
        status.textContent = `${dstWidth}×${dstHeight} in ${dt}ms (browser drawImage, sRGB-space)`;
        return;
      }

      let out: Uint8ClampedArray;
      let note: string;

      // Auto engines run the shared routing policy, pinning their kernel family.
      // auto-ts → inline/shrink via single TS worker, pool for large mild.
      // auto-wasm → same shape, Wasm kernel. auto-sab → pool path uses SAB.
      if (engine === 'auto-ts' || engine === 'auto-wasm' || engine === 'auto-sab') {
        const strat = chooseStrategy({
          srcWidth: src.width, srcHeight: src.height, dstWidth, dstHeight,
        });
        const family = engine === 'auto-wasm' ? 'wasm' : engine === 'auto-sab' ? 'sab' : 'ts';
        if (strat.path === 'pool') {
          // Large + mild → pool. SAB pool when available + requested, else TS pool.
          const useSab = family === 'sab' && SabResizePool.isSupported();
          const p = useSab ? getSabPool() : getPool('pool');
          out = await p.resize(src, dstWidth, dstHeight, {
            kernel, coverageWeightedAlpha: true, tileSize: strat.tile,
          });
          note = `auto: ${useSab ? 'sab ' : ''}pool ${p.size}w t${strat.tile}`;
        } else {
          // inline (small) and shrink (heavy) both go through the single worker;
          // the worker's handleResize auto-routes shrink-then-reduce at >=4x. The
          // 'inline' path here still uses the worker (keeps the main thread free);
          // tileSize 0 so the worker picks whole-image / shrink.
          const r = await client.resize(src.data, {
            width: src.width, height: src.height, dstWidth, dstHeight,
            kernel, coverageWeightedAlpha: true, tileSize: 0,
            engine: family === 'wasm' ? 'wasm' : 'ts',
          });
          out = r.pixels;
          note = `auto: ${strat.path}`;
        }
      } else if (engine === 'sab-pool') {
        if (!SabResizePool.isSupported()) {
          status.textContent = 'SAB pool needs cross-origin isolation (serve with COOP/COEP).';
          return;
        }
        const p = getSabPool();
        out = await p.resize(src, dstWidth, dstHeight, {
          kernel, coverageWeightedAlpha: true, tileSize: tileSize > 0 ? tileSize : 512,
        });
        note = `sab ${p.size}w, tiled ${tileSize > 0 ? tileSize : 512}`;
      } else if (engine === 'pool' || engine === 'wasm-pool') {
        const p = getPool(engine as 'pool' | 'wasm-pool');
        out = await p.resize(src, dstWidth, dstHeight, {
          kernel, coverageWeightedAlpha: true, tileSize: tileSize > 0 ? tileSize : 512,
        });
        note = `${p.size}w, tiled ${tileSize > 0 ? tileSize : 512}`;
      } else {
        const r = await client.resize(src.data, {
          width: src.width,
          height: src.height,
          dstWidth,
          dstHeight,
          kernel,
          coverageWeightedAlpha: true,
          tileSize,
          engine: engine as 'ts' | 'wasm',
        });
        out = r.pixels;
        // Mirror the worker's routing (resizeWorker handleResize): TS engine uses
        // shrink-then-reduce at >=4x downscale, else tiled (if tileSize) / whole.
        const heavy = src.width >= dstWidth * 4 && src.height >= dstHeight * 4;
        if (engine === 'ts' && heavy) {
          note = 'shrink→reduce';
        } else if (engine === 'ts' && tileSize > 0) {
          note = `tiled ${tileSize}`;
        } else {
          note = 'whole image';
        }
      }
      const dt = (performance.now() - t0).toFixed(1);
      paint(workerCanvas, out, dstWidth, dstHeight);
      status.textContent = `${dstWidth}×${dstHeight} in ${dt}ms (${engine}, ${note})`;
    } catch (error) {
      status.textContent = `error: ${(error as Error).message}`;
    } finally {
      busy = false;
      // A request arrived while we were busy — run once more with latest values.
      if (pending) {
        void runResize();
      }
    }
  }

  async function selectImage(index: number): Promise<void> {
    currentIndex = (index + SOURCES.length) % SOURCES.length;
    const source = SOURCES[currentIndex];
    imageSelect.value = String(currentIndex);
    // Size control is only meaningful for synthetic sources.
    sizeSelect.disabled = source.kind !== 'synthetic';
    syncUrl();

    if (source.kind === 'file') {
      const image = await loadImage(IMAGE_DIR + source.file);
      srcData = getImageData(image);
    } else {
      const size = Number(sizeSelect.value);
      status.textContent = `generating ${size}×${size}…`;
      // Yield so the status paints before a large synchronous generate.
      await new Promise(r => setTimeout(r, 0));
      srcData = SYNTHETIC_SOURCES[source.key].generate(size);
    }
    void refreshOutput();
  }

  imageSelect.addEventListener('change', () => void selectImage(Number(imageSelect.value)));
  prevButton.addEventListener('click', () => void selectImage(currentIndex - 1));
  nextButton.addEventListener('click', () => void selectImage(currentIndex + 1));
  document.addEventListener('keydown', (event) => {
    if (event.key === '[' || event.key === 'ArrowLeft') {
      void selectImage(currentIndex - 1);
    } else if (event.key === ']' || event.key === 'ArrowRight') {
      void selectImage(currentIndex + 1);
    }
  });
  scaleNumber.addEventListener('input', () => {
    scaleRange.value = scaleNumber.value;
    syncUrl();
    void refreshOutput();
  });
  scaleRange.addEventListener('input', () => {
    scaleNumber.value = scaleRange.value;
    syncUrl();
    void refreshOutput();
  });
  engineSelect.addEventListener('change', () => {
    syncUrl();
    void refreshOutput();
  });
  kernelSelect.addEventListener('change', () => {
    syncUrl();
    void refreshOutput();
  });
  tileSelect.addEventListener('change', () => {
    syncUrl();
    void refreshOutput();
  });
  // Changing size regenerates the (synthetic) source.
  sizeSelect.addEventListener('change', () => void selectImage(currentIndex));

  // React to back-forward navigation / manual URL edits.
  window.addEventListener('popstate', () => {
    const index = indexFromUrl();
    if (index !== currentIndex) {
      void selectImage(index);
    }
  });

  void selectImage(indexFromUrl());
});
