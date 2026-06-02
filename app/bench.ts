// Headless benchmark harness (plan §7 profiling sweep). Loads in a browser,
// sweeps engine × tile size × worker count over a generated source, averages
// warm runs, and prints a JSON results block to the console (a driver reads it).
// Also compares main-thread getImageData vs createImageBitmap+readback for the
// file-decode question, on the single-worker path where it's architecturally
// correct (see tiled-scaler-plan.md / docs).
//
// Served by the COOP/COEP dev server so the SAB engine is measurable
// (crossOriginIsolated). Build entry `bench`; page app/bench.html.

import { zonePlate } from '../src/synthetic';
import { ResizePool, type PoolTimings } from '../src/worker/pool';
import { SabResizePool } from '../src/worker/sabPool';

import benchHtml from './bench.html';
export const filePaths = { bench: benchHtml };

const TILE_WORKER_URL = './tileWorker.js';
const SAB_WORKER_URL = './sabWorker.js';

const SIZE = 4096;
const SCALE = 0.65;
const KERNEL = 'lanczos2' as const;
const WARMUP = 2;
const RUNS = 6;

function emptyTimings(): PoolTimings {
  return { staging: 0, parallel: 0, blit: 0, tiles: 0, total: 0 };
}

function log(msg: string): void {
  const pre = document.getElementById('out');
  if (pre) {
    pre.textContent += msg + '\n';
  }
  console.log(msg);
}

interface Row {
  engine: string;
  tile: number;
  workers: number;
  totalMs: number;
  stagingMs: number;
  parallelMs: number;
  blitMs: number;
  tiles: number;
}

async function timePool(
  pool: ResizePool | SabResizePool,
  src: ImageData,
  dst: { w: number; h: number },
  tile: number,
): Promise<{ total: number; t: PoolTimings }> {
  const t = emptyTimings();
  await pool.resize(src, dst.w, dst.h, { kernel: KERNEL, tileSize: tile }, t);
  return { total: t.total, t };
}

async function sweep(): Promise<void> {
  const src = zonePlate(SIZE);
  const dstW = Math.floor(SIZE * SCALE);
  const dstH = Math.floor(SIZE * SCALE);
  const cores = navigator.hardwareConcurrency || 8;

  log(`# sweep ${SIZE}² → ${dstW}×${dstH}, kernel ${KERNEL}, ${RUNS} runs (drop ${WARMUP})`);
  log(`# crossOriginIsolated=${globalThis.crossOriginIsolated === true} cores=${cores}`);

  const tiles = [256, 512, 1024];
  const workerCounts = [Math.max(2, Math.floor(cores / 2)), cores, cores * 2]
    .filter((v, i, a) => a.indexOf(v) === i);

  const rows: Row[] = [];

  for (const engine of ['pool', 'sab-pool'] as const) {
    if (engine === 'sab-pool' && !SabResizePool.isSupported()) {
      log('# sab-pool skipped (not cross-origin isolated)');
      continue;
    }
    for (const workers of workerCounts) {
      const pool = engine === 'sab-pool'
        ? new SabResizePool(SAB_WORKER_URL, workers)
        : new ResizePool(TILE_WORKER_URL, workers);
      await pool.whenReady();
      for (const tile of tiles) {
        const samples: PoolTimings[] = [];
        for (let i = 0; i < RUNS; ++i) {
          const { t } = await timePool(pool, src, { w: dstW, h: dstH }, tile);
          samples.push(t);
        }
        const warm = samples.slice(WARMUP);
        const avg = (sel: (t: PoolTimings) => number): number =>
          warm.reduce((s, t) => s + sel(t), 0) / warm.length;
        rows.push({
          engine,
          tile,
          workers,
          totalMs: avg(t => t.total),
          stagingMs: avg(t => t.staging),
          parallelMs: avg(t => t.parallel),
          blitMs: avg(t => t.blit),
          tiles: warm[0].tiles,
        });
      }
      pool.terminate();
    }
  }

  // Table, sorted by total.
  rows.sort((a, b) => a.totalMs - b.totalMs);
  log('\nengine     tile  wk  total  staging parallel blit  tiles');
  for (const r of rows) {
    log(
      `${r.engine.padEnd(9)} ${String(r.tile).padStart(4)} ${String(r.workers).padStart(3)}`
      + `  ${r.totalMs.toFixed(1).padStart(6)} ${r.stagingMs.toFixed(1).padStart(7)}`
      + ` ${r.parallelMs.toFixed(1).padStart(8)} ${r.blitMs.toFixed(1).padStart(5)} ${String(r.tiles).padStart(5)}`,
    );
  }

  log('\n# DONE');
  document.title = 'bench done';
}

window.addEventListener('load', () => {
  void sweep().catch((e: unknown) => log('ERROR: ' + (e as Error).message));
});
