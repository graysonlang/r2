// worker_threads worker for the startup/memory harness. Loads one engine (TS or
// Wasm), reports `ready` the instant its handler is installed, then on each `job`
// resizes and reports timing + this worker's process memory (RSS includes Wasm
// linear memory). The driver (bench-startup.mjs) measures spawn→ready, cold vs
// warm resize, and the RSS/heap high-water over a run — the numbers that set the
// persistent-cost-vs-respawn-cost balance.

import { parentPort, workerData } from 'node:worker_threads';

const { engine, tsBundlePath, wasmPath } = workerData;
const KID = { box: 0, triangle: 1, mitchell: 2, lanczos2: 3, lanczos3: 4 };

let resizeFn; // (srcU8, w, h, dw, dh) -> Uint8ClampedArray
let wasm = null;

async function init() {
  if (engine === 'ts') {
    const { resizeSeparable } = await import(tsBundlePath);
    resizeFn = (s, w, h, dw, dh) => resizeSeparable({ data: s, width: w, height: h }, dw, dh, { kernel: 'lanczos2' });
  } else {
    const createModule = (await import(wasmPath)).default;
    wasm = await createModule();
    resizeFn = (s, w, h, dw, dh) => {
      const sb = w * h * 4, db = dw * dh * 4;
      const sp = wasm._malloc(sb);
      const dp = wasm._malloc(db);
      wasm.HEAPU8.set(s, sp);
      wasm._resize_rgba(sp, w, h, dp, dw, dh, KID.lanczos2, 1, 2.2, 0);
      const o = new Uint8ClampedArray(db);
      o.set(wasm.HEAPU8.subarray(dp, dp + db));
      wasm._free(sp);
      wasm._free(dp);
      return o;
    };
  }
}

function mem() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, wasmBytes: wasm ? wasm.HEAPU8.byteLength : 0 };
}

parentPort.on('message', (msg) => {
  if (msg.type === 'job') {
    const { id, w, h, dw, dh } = msg;
    // Fresh source each job so allocation patterns vary (mimics varied images).
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = (id * 7 + i) & 255;
      src[i + 1] = (i * 3) & 255;
      src[i + 2] = (i * 5) & 255;
      src[i + 3] = 255;
    }
    const t0 = performance.now();
    const out = resizeFn(src, w, h, dw, dh);
    const ms = performance.now() - t0;
    parentPort.postMessage({ type: 'done', id, ms, bytes: out.length, mem: mem() });
  }
});

// Handshake after the kernel is ready (instantiation lag = spawn → this message).
await init();
parentPort.postMessage({ type: 'ready', mem: mem() });
