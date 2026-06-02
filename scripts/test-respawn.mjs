// Unit tests for the high-water respawn policy + ManagedResizeClient, using a
// fake ResizeClient (no real Worker). Verifies: the work-proxy budget triggers a
// recycle at the expected cumulative output, recycle resets usage, maxJobs acts
// as a backstop, and requests serialize so recycles land between jobs.
//
//   node scripts/test-respawn.mjs

import * as esbuild from 'esbuild';

async function importTs(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', write: false,
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
  return import(url);
}

const {
  MB_PER_OUTPUT_MPIX, shouldRespawn, newUsage, recordJob, estimatedGrowthMB,
} = await importTs('src/worker/respawnPolicy.ts');
const { ManagedResizeClient } = await importTs('src/worker/client.ts');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// --- policy unit ---
{
  const u = newUsage();
  recordJob(u, 1000, 1000); // 1 Mpix
  check('estimatedGrowthMB tracks Mpix', Math.abs(estimatedGrowthMB(u) - MB_PER_OUTPUT_MPIX) < 1e-9,
    `${estimatedGrowthMB(u).toFixed(2)}MB`);
  check('under budget → no respawn', !shouldRespawn(u, { budgetMB: 150, maxJobs: 0 }));
}
{
  const u = newUsage();
  // Cross a 10 MB budget: each Mpix ≈ 2.29 MB, so ~5 Mpix.
  for (let i = 0; i < 5; ++i) recordJob(u, 1000, 1000);
  check('over budget → respawn', shouldRespawn(u, { budgetMB: 10, maxJobs: 0 }),
    `${estimatedGrowthMB(u).toFixed(1)}MB >= 10`);
}
{
  const u = newUsage();
  for (let i = 0; i < 3; ++i) recordJob(u, 10, 10);
  check('maxJobs backstop fires', shouldRespawn(u, { budgetMB: 1e9, maxJobs: 3 }));
}

// --- ManagedResizeClient with a fake worker ---
let spawned = 0;
function fakeSpawn() {
  spawned++;
  return {
    whenReady: () => Promise.resolve(),
    // Each resize returns the requested dst size; record one job's worth.
    resize: (_pixels, params) => Promise.resolve({
      pixels: new Uint8ClampedArray(params.dstWidth * params.dstHeight * 4),
      dstWidth: params.dstWidth,
      dstHeight: params.dstHeight,
    }),
    terminate: () => {},
  };
}

const mgr = new ManagedResizeClient('fake://', { budgetMB: 10, maxJobs: 0 }, fakeSpawn);
const px = new Uint8ClampedArray(4);
// Each job is 1000×1000 = 1 Mpix ≈ 2.29 MB; budget 10 MB → recycle after 5 jobs.
const initialSpawns = spawned;
for (let i = 0; i < 12; ++i) {
  await mgr.resize(px, { width: 2000, height: 2000, dstWidth: 1000, dstHeight: 1000, kernel: 'lanczos2', coverageWeightedAlpha: true });
}
// 12 jobs, recycle every 5 → 2 respawns (after job 5 and job 10).
check('managed client respawned at budget', mgr.respawnCount === 2, `respawns=${mgr.respawnCount}`);
check('respawn actually re-spawned workers', spawned - initialSpawns === 2, `spawned Δ=${spawned - initialSpawns}`);
check('usage resets after recycle', mgr.estimatedGrowthMB < 10, `${mgr.estimatedGrowthMB.toFixed(1)}MB`);

// Serialization: interleave many concurrent calls; none should reject or race.
const mgr2 = new ManagedResizeClient('fake://', { budgetMB: 5, maxJobs: 0 }, fakeSpawn);
const results = await Promise.all(
  Array.from({ length: 20 }, () =>
    mgr2.resize(px, { width: 2000, height: 2000, dstWidth: 1000, dstHeight: 1000, kernel: 'lanczos2', coverageWeightedAlpha: true })),
);
check('all concurrent jobs resolved', results.length === 20 && results.every(r => r.pixels.length === 1000 * 1000 * 4));
check('concurrent jobs triggered recycles', mgr2.respawnCount >= 4, `respawns=${mgr2.respawnCount}`);

console.log(failures === 0 ? '\nAll respawn checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
