// Takes the website screenshots from the local dev server with headless Chrome over the DevTools protocol.
//   node app/serve.js            (in another terminal)
//   node web/make-shots.js       -> web/img/results.png, console.png, survey.png
// Needs Chrome or Edge installed; no npm packages.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');

const BASE = process.env.SHOTS_BASE || 'http://localhost:8766';
const SHOTS = [
  { file: 'results.png', url: BASE + '/results.html?theme=light', w: 1440, h: 900 },
  { file: 'console.png', url: BASE + '/console.html?theme=light', w: 1440, h: 900, click: '#survey-list button' },
  { file: 'survey.png', url: BASE + '/survey.html?theme=light#demo', w: 430, h: 900 },
];
const CANDIDATES = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const chrome = CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) { console.error('no Chrome or Edge found'); process.exit(1); }
const port = 9333 + Math.floor(Math.random() * 100);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

const getJson = (p, method) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(b)); } }); }); r.on('error', rej); r.end(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(s) {
  const tab = await getJson('/json/new?' + encodeURIComponent(s.url), 'PUT');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.w < 600 });
  await sleep(2500);
  if (s.click) { await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(s.click)}) && document.querySelector(${JSON.stringify(s.click)}).click()` }); await sleep(800); }
  await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(__dirname, 'img', s.file), Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', s.file);
  ws.close();
  await getJson('/json/close/' + tab.id).catch(() => {});   // answers with plain text
}

(async () => {
  for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch { await sleep(250); } }
  try { for (const s of SHOTS) await shoot(s); }
  finally { proc.kill(); await sleep(500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
