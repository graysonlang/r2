// Unit tests for chooseStrategy() — the resize routing policy. Exercises the
// inline/shrink/pool thresholds and their precedence at the boundaries.
//
//   node scripts/test-strategy.mjs

import * as esbuild from 'esbuild';

async function importTs(entry) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', write: false,
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
  return import(url);
}

const { chooseStrategy, INLINE_MAX_MPIX, SHRINK_RATIO, POOL_TILE } = await importTs('src/worker/strategy.ts');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sq = (s, d) => ({ srcWidth: s, srcHeight: s, dstWidth: d, dstHeight: d });

// Small + mild → inline (no worker).
check('512² mild → inline', chooseStrategy(sq(512, 332)).path === 'inline');
check('1024² mild → inline', chooseStrategy(sq(1024, 665)).path === 'inline');

// Large + mild → pool, tile 256.
{
  const s = chooseStrategy(sq(2048, 1331));
  check('2048² mild → pool', s.path === 'pool', s.reason);
  check('pool uses tile 256', s.tile === POOL_TILE);
}
check('1536² mild → pool', chooseStrategy(sq(1536, 998)).path === 'pool');

// Heavy downscale → shrink, regardless of source size (precedence over inline/pool).
check('small heavy (512→64, 8×) → shrink', chooseStrategy(sq(512, 64)).path === 'shrink');
check('large heavy (4096→256, 16×) → shrink', chooseStrategy(sq(4096, 256)).path === 'shrink');
check('shrink path carries no tile', chooseStrategy(sq(4096, 256)).tile === 0);

// Precedence: a large source at exactly the shrink ratio takes shrink, not pool.
check(`exactly ${SHRINK_RATIO}× → shrink`, chooseStrategy(sq(2048, 512)).path === 'shrink');
// Just under the ratio on a large source → pool.
check('3.9× large → pool', chooseStrategy(sq(2000, 520)).path === 'pool');

// Inline cutoff boundary (~1024² = 1.05MP ≤ 1.1; ~1100² = 1.21MP > 1.1).
check('just under inline cap → inline', chooseStrategy(sq(1024, 700)).path === 'inline');
{
  const big = chooseStrategy(sq(1200, 820)); // 1.44MP, ratio ~1.46 → pool
  check('just over inline cap (mild) → pool', big.path === 'pool', big.reason);
}

// Non-square: ratio is per-axis max.
check('wide heavy on one axis → shrink', chooseStrategy({ srcWidth: 4000, srcHeight: 400, dstWidth: 200, dstHeight: 100 }).path === 'shrink');

console.log(`\nINLINE_MAX_MPIX=${INLINE_MAX_MPIX} SHRINK_RATIO=${SHRINK_RATIO} POOL_TILE=${POOL_TILE}`);
console.log(failures === 0 ? 'All strategy checks passed.' : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
