// Startup + memory harness for the LOCAL worker path (no libvips). For the TS
// engine it spawns a fresh worker_threads worker and measures:
//   - spawn → ready          (instantiation lag a respawn re-pays)
//   - first (cold) resize     vs warm resize  (JIT tier-up tax)
//   - RSS + heap high-water over a long job run  (the creep that motivates a
//     high-water-mark terminate+respawn)
//
//   node scripts/bench-startup.mjs
//
// Goal: concrete numbers to balance persistent memory cost vs warming cost, and
// to pick a sane RSS high-water trigger for respawn-on-demand.

import { Worker } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });

// Bundle separable.ts to a loadable ESM file for the TS worker.
const tsBundlePath = process.cwd() + '/dist/separable.bundle.mjs';
const { outputFiles } = await esbuild.build({
  entryPoints: ['src/separable.ts'], bundle: true, format: 'esm', write: false,
});
writeFileSync(tsBundlePath, outputFiles[0].text);

const W = 2048, H = 2048, DW = 512, DH = 512; // thumbnail-ish job
const JOBS = 200;

function spawn(engine) {
  return new Worker(new URL('./startup-worker.mjs', import.meta.url), {
    workerData: { engine, tsBundlePath },
  });
}

function once(worker, type) {
  return new Promise((resolve) => {
    const h = (m) => {
      if (m.type === type) {
        worker.off('message', h);
        resolve(m);
      }
    };
    worker.on('message', h);
  });
}

async function runEngine(engine) {
  const tSpawn = performance.now();
  const worker = spawn(engine);
  const ready = await once(worker, 'ready');
  const spawnMs = performance.now() - tSpawn;
  const readyMem = ready.mem;

  const times = [];
  let rssHi = readyMem.rss, heapHi = readyMem.heapUsed;
  for (let id = 0; id < JOBS; ++id) {
    const done = once(worker, 'done');
    worker.postMessage({ type: 'job', id, w: W, h: H, dw: DW, dh: DH });
    const r = await done;
    times.push(r.ms);
    rssHi = Math.max(rssHi, r.mem.rss);
    heapHi = Math.max(heapHi, r.mem.heapUsed);
  }
  await worker.terminate();

  const cold = times[0];
  const warm = times.slice(50).reduce((a, b) => a + b, 0) / (times.length - 50);
  const mb = b => (b / 1048576).toFixed(1);
  return { engine, spawnMs, cold, warm, readyRss: readyMem.rss, rssHi, heapHi, mb };
}

console.log(`# startup + memory, ${W}²→${DW}×${DH}, ${JOBS} jobs/worker, lanczos2\n`);
for (const engine of ['ts']) {
  const r = await runEngine(engine);
  console.log(`== ${engine} ==`);
  console.log(`  spawn → ready     ${r.spawnMs.toFixed(1)}ms`);
  console.log(`  cold first resize ${r.cold.toFixed(1)}ms   warm ${r.warm.toFixed(1)}ms   (cold tax ${(r.cold / r.warm).toFixed(1)}x)`);
  console.log(`  RSS at ready      ${r.mb(r.readyRss)} MB`);
  console.log(`  RSS high-water    ${r.mb(r.rssHi)} MB   (Δ ${r.mb(r.rssHi - r.readyRss)} MB over ${JOBS} jobs)`);
  console.log(`  JS heap high      ${r.mb(r.heapHi)} MB`);
  console.log();
}
console.log('# respawn cost ≈ spawn→ready + cold tax; weigh vs RSS Δ growth to set a high-water trigger.');
