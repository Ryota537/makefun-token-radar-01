// Screenshot helper for the entry's own dashboard: drives the machine's Chromium over CDP
// (no browser extension, no network) and captures the three views the bounty hands in.
//
// Usage:
//   node tools/screenshot.mjs [out-dir]
//   CHROME=/opt/meta-chromium/chrome node tools/screenshot.mjs
//
// The Chromium on this machine is the Hatch build, which needs its WebGL domain policy
// switches to start: --hatch-webgl-allowed-domains-file with a file holding the header
// line "hatch-webgl-allowed-domains-v1" and its sha256. The policy file is written to a
// scratch directory first; it allows no domains, which is all a local file needs.
//
// The three shots, all at 1440x800 (the gate's long side at most 1440, short side at least
// 800):
//   1-board.png     the board, no filter
//   2-detail.png    the top row's detail drawer, via #p=<slug>
//   3-filtered.png  the board filtered to one category, via #category=<name>
//
// The page under test is out/dashboard/index.html, the output of main.ts, so the shots are
// renders of the entry's own dashboard on its own data. Run main.ts first.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const outDir = resolve(process.argv[2] ?? join(root, 'out'));
const chrome = process.env.CHROME ?? '/opt/meta-chromium/chrome';
const PORT = 9333;

const policy = 'hatch-webgl-allowed-domains-v1\n';
const policyPath = join('/tmp', 'token-radar-policy.txt');
writeFileSync(policyPath, policy);
const policySha = createHash('sha256').update(policy).digest('hex');

const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
const top = board.rows[0];
if (!top) throw new Error('board.json holds no rows');
const category = top.category ?? 'Other';
const pageUrl = pathToFileURL(join(outDir, 'dashboard', 'index.html')).href;

const shots = [
  { name: '1-board.png', url: pageUrl },
  { name: '2-detail.png', url: `${pageUrl}#p=${top.slug}` },
  { name: '3-filtered.png', url: `${pageUrl}#category=${encodeURIComponent(category)}` },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(path) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`CDP on :${PORT} never answered ${path}`);
}

const child = spawn(chrome, [
  '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--disable-extensions', '--disable-sync',
  `--user-data-dir=/tmp/token-radar-chrome-${process.pid}`,
  `--hatch-webgl-allowed-domains-file=${policyPath}`,
  `--hatch-webgl-allowed-domains-sha256=${policySha}`,
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,800',
  'about:blank',
], { stdio: 'ignore' });

let code = 0;
try {
  const version = await getJson('/json/version');
  if (!version.webSocketDebuggerUrl) throw new Error('no browser websocket url');

  for (const shot of shots) {
    // A fresh target per shot, so each view starts from a clean page.
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (shot ${shot.name})`));
        else resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: shot.url });
    // The page renders synchronously from data.js; wait for the load event plus a beat
    // so the dialog (detail shot) is open and painted.
    await sleep(2500);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(data, 'base64');
    const dest = join(root, 'screenshots', shot.name);
    mkdirSync(join(root, 'screenshots'), { recursive: true });
    writeFileSync(dest, bytes);
    console.log(`shot ${shot.name}: ${bytes.length} bytes (${shot.url.includes('#') ? shot.url.slice(shot.url.indexOf('#')) : 'board'})`);
    ws.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  }
} catch (err) {
  code = 1;
  console.error(`screenshot: ${err.message}`);
} finally {
  child.kill('SIGKILL');
}

process.exit(code);
