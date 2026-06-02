// Static file server for dist/ that sets COOP/COEP so the page is
// cross-origin isolated (crossOriginIsolated === true) and SharedArrayBuffer is
// available — the prerequisite for the SAB worker pool.
//
//   npm run build && node scripts/serve-sab.mjs [port]
//
// esp's dev server (npm run dev) does NOT set these headers, so the SAB pool
// engine only works when served from here. Plain static serving, no watch.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] ?? 8200);
const ROOT = 'dist';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  // Cross-origin isolation headers on every response — required for SAB.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  let pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (pathname === '/') {
    pathname = '/index.html';
  }
  // Contain to ROOT (no path traversal).
  const filePath = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`SAB server (COOP/COEP) on http://localhost:${PORT}  (serving ${ROOT}/)`);
});
