const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.RELEASE_BASE = 'https://rel.example/surveycx/0.2.0'; process.env.CUSTOMERS_TABLE = 'customers';
const { handler, launchUrl, tokenFrom } = require('./register.js');
const { parseRecord } = require('./notify.js');

test('launchUrl carries license, account, product code, template and site archive', () => {
  const full = launchUrl('arn:lic-1', '111122223333', 'prod-1', { releaseBase: 'https://rel.example/surveycx/0.2.0', region: 'us-east-1' });
  assert.ok(full.startsWith('https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?'));
  const q = new URLSearchParams(full.slice(full.lastIndexOf('?') + 1));
  assert.equal(q.get('templateURL'), 'https://rel.example/surveycx/0.2.0/template.yaml');
  assert.equal(q.get('param_MarketplaceLicenseArn'), 'arn:lic-1'); assert.equal(q.get('param_MarketplaceCustomerAccountId'), '111122223333'); assert.equal(q.get('param_MarketplaceProductCode'), 'prod-1');
  assert.equal(q.get('param_SiteArchiveUrl'), 'https://rel.example/surveycx/0.2.0/site.zip'); assert.equal(q.get('stackName'), 'surveycx');
});

test('tokenFrom reads plain and base64 form bodies', () => {
  assert.equal(tokenFrom({ body: 'x-amzn-marketplace-token=abc%2Bdef' }), 'abc+def');
  assert.equal(tokenFrom({ body: Buffer.from('x-amzn-marketplace-token=zzz').toString('base64'), isBase64Encoded: true }), 'zzz');
  assert.equal(tokenFrom({ body: 'other=1' }), null);
});

function fake(resolve) {
  const writes = [];
  return { writes, clients: { metering: { send: async () => { if (resolve instanceof Error) throw resolve; return resolve; } }, ResolveCustomerCommand: function (i) { this.input = i; },
    ddb: { send: async (c) => { writes.push(c.input); } }, UpdateCommand: function (i) { this.input = i; } } };
}
const req = (method, body) => ({ rawPath: '/register', requestContext: { http: { method } }, body });

test('POST with a valid token resolves the customer, records them, and shows the launch page', async () => {
  const f = fake({ LicenseArn: 'arn:aws:license-manager::111122223333:license:l-1', CustomerIdentifier: 'cust-1', ProductCode: 'prod-1', CustomerAWSAccountId: '111122223333' });
  const r = await handler(req('POST', 'x-amzn-marketplace-token=tok'), {}, { clients: f.clients, now: () => new Date('2026-09-26T10:00:00Z') });
  assert.equal(r.statusCode, 200); assert.match(r.body, /Launch SurveyCX in CloudFormation/); assert.match(r.body, /all three<\/b> acknowledgement/); assert.match(r.body, /111122223333/); assert.match(r.body, /param_MarketplaceLicenseArn=arn/);
  assert.equal(f.writes[0].Key.licenseArn, 'arn:aws:license-manager::111122223333:license:l-1'); assert.equal(f.writes[0].ExpressionAttributeValues[':a'], '111122223333');
});

test('POST without a token or with a bad token is a friendly 400', async () => {
  assert.equal((await handler(req('POST', ''), {}, { clients: fake({}).clients })).statusCode, 400);
  const bad = await handler(req('POST', 'x-amzn-marketplace-token=expired'), {}, { clients: fake(Object.assign(new Error('nope'), { name: 'InvalidTokenException' })).clients });
  assert.equal(bad.statusCode, 400); assert.match(bad.body, /could not be verified/);
  const noLic = await handler(req('POST', 'x-amzn-marketplace-token=tok'), {}, { clients: fake({ CustomerIdentifier: 'cust-1', ProductCode: 'prod-1' }).clients });
  assert.equal(noLic.statusCode, 400);
});

test('GET shows the landing page; /health is JSON', async () => {
  assert.match((await handler(req('GET'), {}, { clients: fake({}).clients })).body, /Set up your account/);
  assert.equal(JSON.parse((await handler({ rawPath: '/health', requestContext: { http: { method: 'GET' } } }, {}, { clients: fake({}).clients })).body).ok, true);
});

test('notify parses Marketplace license events and ignores junk', () => {
  const ev = { 'detail-type': 'License Updated - Manufacturer', source: 'aws.agreement-marketplace', time: '2026-09-26T10:00:00Z',
    detail: { agreement: { id: 'agmt-1' }, acceptor: { accountId: '111122223333' }, offer: { id: 'offer-1' }, product: { code: 'prod-1', id: 'prod-x' }, license: { arn: 'arn:lic-1' } } };
  const p = parseRecord(ev);
  assert.equal(p.licenseArn, 'arn:lic-1'); assert.equal(p.state, 'active'); assert.equal(p.productCode, 'prod-1'); assert.equal(p.accountId, '111122223333'); assert.equal(p.agreementId, 'agmt-1');
  assert.equal(parseRecord(Object.assign({}, ev, { 'detail-type': 'License Deprovisioned - Manufacturer' })).state, 'deprovisioned');
  assert.equal(parseRecord({ detail: {} }), null);
  assert.equal(parseRecord({ 'detail-type': 'Something Else', detail: { license: { arn: 'x' } } }), null);
});
