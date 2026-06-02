import pluginEmcc from '@graysonlang/esp/esbuild-plugin-emcc';
import pluginGlobCopy from '@graysonlang/esp/esbuild-plugin-glob-copy';
import pluginImp from '@graysonlang/esp/esbuild-plugin-imp';
import { runBuild } from '@graysonlang/esp/esbuild-runner';

// emcc flags for the .c kernel. SINGLE_FILE embeds the wasm as base64 in the
// emitted JS, so the worker bundle has no separate .wasm to fetch (avoids
// worker-relative path issues); the resize kernel is small enough that this is
// fine. -msimd128 selects the f32x4 tap loops in resize.c (SIMD128 is baseline in
// all current browsers). The build runner adds -Os -sENVIRONMENT=web
// -sEXPORT_ES6=1 -sMODULARIZE=1.
const EMCC_OPTIONS = [
  '-sSINGLE_FILE=1',
  '-sALLOW_MEMORY_GROWTH=1',
  '-msimd128',
  '-sEXPORTED_FUNCTIONS=_resize_rgba,_resize_init,_resize_tile,_resize_free,_malloc,_free',
  '-sEXPORTED_RUNTIME_METHODS=HEAPU8',
].join(' ');

function getOptions(args, verbose, logger) {
  return {
    assetNames: '[name]',
    bundle: true,
    entryPoints: {
      index: 'src/index.js',
      main: 'app/main.ts',
      reference: 'app/reference.ts',
      bench: 'app/bench.ts',
      resizeWorker: 'src/worker/resizeWorker.ts',
      tileWorker: 'src/worker/tileWorker.ts',
      wasmTileWorker: 'src/worker/wasmTileWorker.ts',
      sabWorker: 'src/worker/sabWorker.ts',
    },
    format: 'esm',
    loader: {
      '.html': 'file',
    },
    outdir: 'dist',
    plugins: [
      pluginEmcc({ logger, verbose, emccOptions: EMCC_OPTIONS.split(/\s+/) }),
      pluginGlobCopy({ logger }),
      pluginImp({ logger, verbose }),
    ],
    target: ['esnext'],
    ...args,
  };
}

runBuild(getOptions);
