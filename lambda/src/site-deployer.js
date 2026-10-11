/*
 * CloudFormation custom resource: installs the SurveyCX pages into the stack's own site bucket.
 *
 * On Create/Update: downloads site.zip from the release location, unzips it (stored or deflate
 * entries, no dependency), writes each file with the right content type, adds config.js pointing
 * the pages at /api and the stack's Cognito client, registers the site as a sign-in callback on
 * that client, and invalidates CloudFront. On Delete: empties the bucket so the stack can remove it.
 *
 * This is what lets a customer launch the template and open the site with nothing to run by hand.
 */
'use strict';
const https = require('https');
const zlib = require('zlib');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return fetchBuffer(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error('download ' + url + ' -> ' + res.statusCode));
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    }).on('error', reject);
  });
}

/** Minimal zip reader: walks the central directory, returns [{name, data}] for files (directories skipped). */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  const out = []; let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lxlen, raw = buf.subarray(start, start + csize);
    out.push({ name: name.replace(/\\/g, '/'), data: method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : (() => { throw new Error('unsupported zip method ' + method); })() });
  }
  return out;
}

function configJs(p) {
  const cfg = { api: '/api' };
  if (p.Brand) cfg.brand = p.Brand;
  if (p.AuthDomain && p.ClientId) cfg.auth = { domain: p.AuthDomain, clientId: p.ClientId };
  return 'window.SURVEYCX_CONFIG = ' + JSON.stringify(cfg) + ';\n';
}

function indexHtml() {
  return '<!doctype html><meta charset="utf-8"><title>SurveyCX for Amazon Connect</title>'
    + '<style>body{font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}a{display:block;margin:.4rem 0}</style>'
    + '<h1>SurveyCX for Amazon Connect</h1><a href="console.html">Survey console</a><a href="results.html">Results</a>\n';
}

async function install(p, clients) {
  const files = unzip(await fetchBuffer(p.ArchiveUrl));
  const puts = files.map((f) => ({ Key: f.name, Body: f.data, ContentType: TYPES[f.name.slice(f.name.lastIndexOf('.'))] || 'application/octet-stream', CacheControl: 'public, max-age=60' }));
  puts.push({ Key: 'config.js', Body: configJs(p), ContentType: TYPES['.js'], CacheControl: 'no-cache' });
  puts.push({ Key: 'index.html', Body: indexHtml(), ContentType: TYPES['.html'], CacheControl: 'public, max-age=60' });
  for (const o of puts) await clients.s3.send(new clients.PutObjectCommand(Object.assign({ Bucket: p.Bucket }, o)));
  if (p.UserPoolId && p.ClientId) {
    const cur = (await clients.cognito.send(new clients.DescribeUserPoolClientCommand({ UserPoolId: p.UserPoolId, ClientId: p.ClientId }))).UserPoolClient || {};
    const pages = ['console.html', 'results.html'].map((x) => p.SiteUrl + '/' + x);
    const cb = Array.from(new Set([...(cur.CallbackURLs || []), ...pages])), lo = Array.from(new Set([...(cur.LogoutURLs || []), p.SiteUrl + '/']));
    await clients.cognito.send(new clients.UpdateUserPoolClientCommand({ UserPoolId: p.UserPoolId, ClientId: p.ClientId, CallbackURLs: cb, LogoutURLs: lo,
      AllowedOAuthFlows: cur.AllowedOAuthFlows || ['code'], AllowedOAuthScopes: cur.AllowedOAuthScopes || ['openid', 'email', 'profile'], AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: cur.SupportedIdentityProviders || ['COGNITO'], PreventUserExistenceErrors: cur.PreventUserExistenceErrors || 'ENABLED',
      AccessTokenValidity: cur.AccessTokenValidity, IdTokenValidity: cur.IdTokenValidity, RefreshTokenValidity: cur.RefreshTokenValidity, TokenValidityUnits: cur.TokenValidityUnits, ReadAttributes: cur.ReadAttributes }));
  }
  if (p.SiteUrl && clients.store) { const cur = await clients.store.getSettings(); await clients.store.putSettings(Object.assign({}, cur, { siteUrl: p.SiteUrl })); }
  await clients.cloudfront.send(new clients.CreateInvalidationCommand({ DistributionId: p.DistributionId, InvalidationBatch: { CallerReference: String(Date.now()), Paths: { Quantity: 1, Items: ['/*'] } } }));
  return { files: puts.length };
}

async function emptyBucket(bucket, clients) {
  let token, removed = 0;
  do {
    const r = await clients.s3.send(new clients.ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    const objs = (r.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) { await clients.s3.send(new clients.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs } })); removed += objs.length; }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

function respond(event, status, data, reason) {
  const body = JSON.stringify({ Status: status, Reason: reason || 'see CloudWatch log', PhysicalResourceId: event.PhysicalResourceId || (event.ResourceProperties && event.ResourceProperties.Bucket) || 'surveycx-site', StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId, Data: data || {} });
  return new Promise((resolve) => {
    const u = new URL(event.ResponseURL);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'PUT', headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve); req.write(body); req.end();
  });
}

function realClients() {
  const s3 = require('@aws-sdk/client-s3'), cf = require('@aws-sdk/client-cloudfront'), cg = require('@aws-sdk/client-cognito-identity-provider');
  return { s3: new s3.S3Client({}), PutObjectCommand: s3.PutObjectCommand, ListObjectsV2Command: s3.ListObjectsV2Command, DeleteObjectsCommand: s3.DeleteObjectsCommand,
    cloudfront: new cf.CloudFrontClient({}), CreateInvalidationCommand: cf.CreateInvalidationCommand,
    cognito: new cg.CognitoIdentityProviderClient({}), DescribeUserPoolClientCommand: cg.DescribeUserPoolClientCommand, UpdateUserPoolClientCommand: cg.UpdateUserPoolClientCommand, store: require('./store.js') };
}

exports.handler = async (event, context, deps) => {
  const clients = (deps && deps.clients) || realClients();
  const p = event.ResourceProperties || {};
  try {
    let data = {};
    if (event.RequestType === 'Delete') data = { removed: await emptyBucket(p.Bucket, clients) };
    else data = await install(p, clients);
    console.log(JSON.stringify({ requestType: event.RequestType, ...data }));
    await respond(event, 'SUCCESS', data);
  } catch (err) {
    console.error(err);
    // A failed Delete must not wedge the stack: report success after logging; the bucket then fails to delete on its own terms.
    await respond(event, event.RequestType === 'Delete' ? 'SUCCESS' : 'FAILED', {}, String(err.message || err).slice(0, 200));
  }
};

exports.unzip = unzip;
exports.configJs = configJs;
exports.install = install;
