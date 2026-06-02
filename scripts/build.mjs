import pluginGlobCopy from '@graysonlang/esp/esbuild-plugin-glob-copy';
import pluginImp from '@graysonlang/esp/esbuild-plugin-imp';
import { runBuild } from '@graysonlang/esp/esbuild-runner';

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
      sabWorker: 'src/worker/sabWorker.ts',
    },
    format: 'esm',
    loader: {
      '.html': 'file',
    },
    outdir: 'dist',
    plugins: [
      pluginGlobCopy({ logger }),
      pluginImp({ logger, verbose }),
    ],
    target: ['esnext'],
    ...args,
  };
}

runBuild(getOptions);
