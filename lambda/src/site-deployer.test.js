const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('zlib');
const { unzip, configJs, install } = require('./site-deployer.js');

/** Build a real zip in memory (deflate + one stored entry) so the reader is tested against the format, not a mock. */
function makeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content, stored] of entries) {
    const raw = Buffer.from(content), data = stored ? raw : zlib.deflateRawSync(raw), nameB = Buffer.from(name);
    const crc = 0; // not verified by the reader
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(stored ? 0 : 8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(stored ? 0 : 8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, data); centrals.push(ch, nameB); offset += lh.length + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('unzip reads deflate and stored entries and skips directories', () => {
  const zip = makeZip([['console.html', '<meta charset="utf-8"><title>Panel</title>'], ['surveycx-core.js', 'window.SurveyCX = 1;', true], ['sub/', '', true]]);
  const files = unzip(zip);
  assert.deepEqual(files.map((f) => f.name), ['console.html', 'surveycx-core.js']);
  assert.equal(files[0].data.toString(), '<meta charset="utf-8"><title>Panel</title>');
  assert.equal(files[1].data.toString(), 'window.SurveyCX = 1;');
  assert.throws(() => unzip(Buffer.from('nope')), /not a zip/);
});

test('configJs points at /api and includes auth only when both parts exist', () => {
  assert.equal(configJs({}), 'window.SURVEYCX_CONFIG = {"api":"/api"};\n');
  assert.match(configJs({ Brand: 'Acme', AuthDomain: 'https://a', ClientId: 'c' }), /"brand":"Acme".*"auth":\{"domain":"https:\/\/a","clientId":"c"\}/);
  assert.equal(configJs({ AuthDomain: 'https://a' }).includes('auth'), false);
});

test('install writes every file plus config and index, registers callbacks, invalidates', async () => {
  const zip = makeZip([['console.html', '<p>'], ['surveycx-core.js', ';']]);
  const puts = [], sent = [];
  const clients = {
    s3: { send: async (c) => { puts.push(c.input); } }, PutObjectCommand: function (i) { this.input = i; },
    cognito: { send: async (c) => { sent.push(c); return c.kind === 'describe' ? { UserPoolClient: { CallbackURLs: ['http://localhost:8765/console.html'], AllowedOAuthFlows: ['code'] } } : {}; } },
    DescribeUserPoolClientCommand: function (i) { this.kind = 'describe'; this.input = i; }, UpdateUserPoolClientCommand: function (i) { this.kind = 'update'; this.input = i; },
    cloudfront: { send: async (c) => { sent.push(c); } }, CreateInvalidationCommand: function (i) { this.kind = 'inv'; this.input = i; },
  };
  const https = require('https');
  const orig = https.get;
  https.get = (url, cb) => { const { PassThrough } = require('stream'); const res = new PassThrough(); res.statusCode = 200; res.headers = {}; process.nextTick(() => { cb(res); res.end(zip); }); return { on: () => ({}) }; };
  try {
    const r = await install({ ArchiveUrl: 'https://example.test/site.zip', Bucket: 'b', DistributionId: 'D1', SiteUrl: 'https://d.cloudfront.net', Team: 'Billing', UserPoolId: 'p', ClientId: 'c', AuthDomain: 'https://auth' }, clients);
    assert.equal(r.files, 4);
    assert.deepEqual(puts.map((p) => p.Key).sort(), ['config.js', 'console.html', 'index.html', 'surveycx-core.js']);
    assert.equal(puts.find((p) => p.Key === 'console.html').ContentType, 'text/html; charset=utf-8');
    assert.equal(puts.find((p) => p.Key === 'config.js').CacheControl, 'no-cache');
    const upd = sent.find((c) => c.kind === 'update').input;
    assert.ok(upd.CallbackURLs.includes('https://d.cloudfront.net/console.html')); assert.ok(upd.CallbackURLs.includes('http://localhost:8765/console.html'));
    assert.equal(sent.find((c) => c.kind === 'inv').input.DistributionId, 'D1');
  } finally { https.get = orig; }
});
