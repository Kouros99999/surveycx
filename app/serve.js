// Local dev server: the pages from app/ plus the real API handler over an in-memory store, seeded with demo data.
//   node app/serve.js            -> http://localhost:8766/console.html  (everyone is a supervisor; no sign-in)
'use strict';
process.env.AUTH_MODE = 'none';
const http = require('http'), fs = require('fs'), path = require('path');
require('child_process').execFileSync('node', [path.join(__dirname, '..', 'lambda', 'build.js')], { stdio: 'ignore' });
const mem = require('../lambda/src/memstore.js');
const api = require('../lambda/src/api.js');
const seed = require('./demo-seed.js');

const store = mem.make();
const handler = api.makeHandler({ store, clients: {}, post: async (url, body) => console.log('-> Arena', url, JSON.stringify(body).slice(0, 120)) });
seed.seed(store).then(() => console.log('seeded demo data'));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PORT = +(process.env.PORT || 8766);
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    let body = ''; for await (const c of req) body += c;
    const ev = { rawPath: u.pathname.slice(4), requestContext: { http: { method: req.method }, authorizer: { jwt: { claims: { 'cognito:groups': ['supervisors'], 'cognito:username': 'dev' } } } }, queryStringParameters: Object.fromEntries(u.searchParams), body: body || undefined };
    const r = await handler(ev);
    res.writeHead(r.statusCode, r.headers); res.end(r.body); return;
  }
  let file = u.pathname === '/' ? '/console.html' : u.pathname;
  if (file === '/config.js') { res.writeHead(200, { 'content-type': TYPES['.js'] }); res.end("window.SURVEYCX_CONFIG = { api: '/api' };\n"); return; }
  const p = path.join(__dirname, file);
  if (!p.startsWith(__dirname) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(p));
}).listen(PORT, () => console.log(`SurveyCX dev: http://localhost:${PORT}/console.html  results: /results.html  web survey: /survey.html#demo`));
