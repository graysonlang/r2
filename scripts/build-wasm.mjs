// Compiles src/wasm/resize.c to a Wasm ES6 module under dist-wasm/ for testing
// and as the artifact the worker loads. Kept separate from the esp/esbuild app
// build so the kernel can be (re)built and tested on its own.
//
//   node scripts/build-wasm.mjs
//
// Output: dist-wasm/resize.mjs (+ resize.wasm). Exports resize_rgba, malloc,
// free, and the heap views via the default Emscripten module factory.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const OUT_DIR = 'dist-wasm';
mkdirSync(OUT_DIR, { recursive: true });

const useSimd = process.argv.includes('--simd');

const flags = [
  'src/wasm/resize.c',
  '-o', `${OUT_DIR}/resize.mjs`,
  '-O3',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  // Node can load the default 'web'-ish factory fine; allow both so the same
  // artifact runs in the test harness and the browser worker.
  '-sENVIRONMENT=web,worker,node',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sEXPORTED_FUNCTIONS=_resize_rgba,_resize_init,_resize_tile,_resize_free,_malloc,_free',
  '-sEXPORTED_RUNTIME_METHODS=HEAPU8',
  ...(useSimd ? ['-msimd128'] : []),
];

console.log(`emcc ${flags.join(' ')}`);
execFileSync('emcc', flags, { stdio: 'inherit' });
console.log(`Wrote ${OUT_DIR}/resize.mjs`);
