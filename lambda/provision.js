// Stands up one SurveyCX stack per client, for partners who run a stack for each tenant (data never shared).
//
//   node lambda/provision.js <stack name> --version 0.1.0 [--region us-east-1] [--partner VeriCX] [--provider generic|connect]
//        [--brand "Client name"] [--accent "#0f766e"] [--logo https://...] [--webhook https://... --secret ...] [--low-only]
//        [--connect-instance <id> --connect-url https://x.my.connect.aws] [--timezone America/New_York] [--alarm-email a@b.c]
//        [--license-arn ... --customer-account ... --product-code ...]   (Marketplace billing; leave out for direct deals)
//        [--delete]
//
// What it does: deploys the published release template with those parameters, waits, then writes the client's first
// ingest key, data key, brand and webhook straight into the stack's table, and prints the site URL and the keys ONCE.
// Idempotent: running it again on an existing stack updates parameters and keeps existing keys and settings.
// Needs the AWS CLI on PATH with credentials for the account the stack goes in.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const args = process.argv.slice(2);
const stack = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const region = opt('region', process.env.AWS_REGION || 'us-east-1'), version = opt('version', ''), bucket = opt('bucket', 'surveycx-releases-533267257907');
if (!stack || !/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/.test(stack)) { console.error('usage: node lambda/provision.js <stack name> --version x.y.z [options]'); process.exit(1); }

const aws = (...a) => execFileSync('aws', [...a, '--region', region, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const j = (s) => (s ? JSON.parse(s) : null);

if (flag('delete')) {
  aws('cloudformation', 'delete-stack', '--stack-name', stack);
  console.log(`deleting ${stack}; the table, keys and responses go with it. The site bucket is emptied by the stack's own installer.`);
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error('--version x.y.z is required (a published release)'); process.exit(1); }

// 1. Deploy or update the stack from the published template.
const base = `https://${bucket}.s3.${region}.amazonaws.com/surveycx/${version}`;
const params = { SiteArchiveUrl: `${base}/site.zip`, Provider: opt('provider', opt('connect-instance') ? 'connect' : 'generic'), Partner: opt('partner', ''), Timezone: opt('timezone', 'UTC'),
  ConnectInstanceId: opt('connect-instance', ''), ConnectInstanceUrl: opt('connect-url', ''), AlarmEmail: opt('alarm-email', ''),
  MarketplaceLicenseArn: opt('license-arn', ''), MarketplaceCustomerAccountId: opt('customer-account', ''), MarketplaceProductCode: opt('product-code', '') };
const overrides = Object.entries(params).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`);
console.log(`deploying ${stack} from ${base}/template.yaml ...`);
try {
  execFileSync('aws', ['cloudformation', 'deploy', '--template-file', downloadTemplate(base), '--stack-name', stack, '--region', region, '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND', '--no-fail-on-empty-changeset', '--parameter-overrides', ...overrides], { stdio: 'inherit' });
} catch (e) { console.error('deploy failed'); process.exit(1); }

// 2. Outputs.
const outputs = Object.fromEntries(j(aws('cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs')).map((o) => [o.OutputKey, o.OutputValue]));
const table = outputs.TableName, site = outputs.SiteUrl;

// 3. Settings: brand and webhook, merged into whatever the installer already wrote (siteUrl).
const get = (pk, sk) => (j(aws('dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ pk: { S: pk }, sk: { S: sk } }))) || {}).Item || null;
const M = (v) => Array.isArray(v) ? { L: v.map(M) } : v === null ? { NULL: true } : typeof v === 'object' ? { M: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, M(x)])) } : typeof v === 'number' ? { N: String(v) } : typeof v === 'boolean' ? { BOOL: v } : { S: String(v) };
const U = (v) => v == null ? v : 'S' in v ? v.S : 'N' in v ? Number(v.N) : 'BOOL' in v ? v.BOOL : 'NULL' in v ? null : 'L' in v ? v.L.map(U) : 'M' in v ? Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, U(x)])) : v;
const put = (item) => aws('dynamodb', 'put-item', '--table-name', table, '--item', JSON.stringify(M(item).M));
const settings = Object.assign({}, U({ M: get('CONFIG', 'SETTINGS') || {} }) || {}, { pk: 'CONFIG', sk: 'SETTINGS' });
if (opt('brand')) settings.brand = Object.assign({}, settings.brand || {}, { name: opt('brand'), accent: opt('accent', (settings.brand || {}).accent || '#0f766e'), logoUrl: opt('logo', (settings.brand || {}).logoUrl || '') });
if (opt('webhook')) { const hooks = (settings.webhooks || []).filter((w) => w.url !== opt('webhook')); hooks.push({ url: opt('webhook'), secret: opt('secret', ''), events: [flag('low-only') ? 'low' : 'completed'], label: opt('partner', 'partner') }); settings.webhooks = hooks.slice(0, 5); }
if (!settings.closedLoop) settings.closedLoop = { enabled: true, attribute: 'csat', taskFlowId: '' };
put(settings);

// 4. A starter survey if the table has none.
if (!get('CONFIG', 'SURVEY#default')) {
  const S = require('../app/surveycx-core.js');
  const s = S.normalizeSurvey(Object.assign({ id: 'default', target: { queues: [], attribute: null, channels: S.CHANNELS, sample: 100 } }, S.DEFAULT_SURVEY));
  s.createdAt = s.updatedAt = new Date().toISOString(); s.updatedBy = 'provision';
  put(Object.assign({ pk: 'CONFIG', sk: 'SURVEY#default' }, s));
}

// 5. Keys: one ingest, one data, created only if none of that kind exists yet.
const existing = (j(aws('dynamodb', 'scan', '--table-name', table, '--filter-expression', 'begins_with(pk, :p)', '--expression-attribute-values', JSON.stringify({ ':p': { S: 'KEY#' } }), '--projection-expression', 'pk, kind')).Items || []).map((i) => U({ M: i }));
const made = {};
for (const kind of ['ingest', 'data']) {
  if (existing.some((k) => k.kind === kind)) continue;
  const key = (kind === 'ingest' ? 'ik_' : 'dk_') + crypto.randomBytes(24).toString('base64url');
  put({ pk: 'KEY#' + key, sk: 'META', kind, label: `${opt('partner', 'Partner')} ${kind}`, createdAt: new Date().toISOString(), createdBy: 'provision', expiresAt: new Date(Date.now() + 3650 * 86400000).toISOString() });
  made[kind] = key;
}

console.log(`\n${stack} is ready.`);
console.log(`  site / console / results:  ${site}/console.html   ${site}/results.html`);
console.log(`  API base:                  ${site}/api`);
if (made.ingest) console.log(`  ingest key (shown once):   ${made.ingest}`); else console.log('  ingest key:                already existed; create another in the console if needed');
if (made.data) console.log(`  data key (shown once):     ${made.data}`); else console.log('  data key:                  already existed');
if (outputs.UserPoolId) console.log(`  sign-ins:                  Cognito pool ${outputs.UserPoolId} (node lambda/sync-users.js ${stack} --instance <id>, or create users in the pool)`);
if (outputs.FlowLambdaArn) console.log(`  Connect:                   node lambda/flow-module.js ${outputs.FlowLambdaArn}; stream ${outputs.StreamArn}`);

function downloadTemplate(base) {
  const fs = require('fs'), path = require('path'), os = require('os');
  const f = path.join(os.tmpdir(), `surveycx-${version}-template.yaml`);
  execFileSync('curl', ['-sfL', '-o', f, `${base}/template.yaml`]);
  return f;
}
