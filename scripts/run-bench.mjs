// Drives headless Chrome to run the bench page and prints its console output.
// Usage: node scripts/run-bench.mjs <url>
import { spawn } from 'node:child_process';
import http from 'node:http';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9340;
const URL = process.argv[2] ?? 'http://localhost:8310/bench.html';
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = p => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });
function wrap(ws) { const hs = []; ws.addEventListener('message', e => hs.forEach(h => h(e.data))); return { send: s => ws.send(s), on: h => hs.push(h) }; }
try {
  let t; for (let i = 0; i < 80; i++) { try { const l = await getJSON('/json'); t = l.find(x => x.type === 'page'); if (t) break; } catch {} await sleep(250); }
  const sock = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => sock.addEventListener('open', r));
  const ws = wrap(sock);
  ws.on(raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.consoleAPICalled') { console.log(m.params.args.map(a => a.value ?? '').join(' ')); } });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  ws.send(JSON.stringify({ id: 2, method: 'Page.enable' }));
  ws.send(JSON.stringify({ id: 3, method: 'Page.navigate', params: { url: URL } }));
  // Wait until the page sets document.title to 'bench done' (or timeout).
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const id = 1000 + i;
    let title = '';
    const p = new Promise(res => ws.on(raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); }));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }));
    title = await p;
    if (title === 'bench done') break;
  }
  await sleep(300);
} finally { chrome.kill('SIGKILL'); }
