const assert = require('node:assert/strict');
const { test } = require('node:test');
const S = require('./surveycx-core.js');
const mem = require('./memstore.js');
const api = require('./api.js');
const delivery = require('./delivery.js');

const sup = { 'cognito:groups': ['supervisors'], 'cognito:username': 'boss' };
const agent = (arn) => ({ 'cognito:groups': ['agents'], 'custom:agentArn': arn });
const req = (method, path, body, claims, qs) => ({ rawPath: path, requestContext: { http: { method }, authorizer: claims ? { jwt: { claims } } : undefined }, queryStringParameters: qs, body: body ? JSON.stringify(body) : undefined });
const call = async (h, ...a) => { const r = await h(req(...a)); return Object.assign(r, { json: r.headers['content-type'].startsWith('application/json') ? JSON.parse(r.body) : null }); };

test('route table', () => {
  assert.equal(api.route('GET', '/surveys/abc').name, 'getSurvey'); assert.equal(api.route('POST', '/s/t_1/answers').token, 't_1'); assert.equal(api.route('GET', '/ingest/x/contacts'), null);
});

test('surveys: create, list, update, delete; supervisors only; validation errors are 400', async () => {
  const s = mem.make(); const h = api.makeHandler({ store: s, now: () => new Date('2026-10-11T10:00:00Z') });
  let r = await call(h, 'POST', '/surveys', S.DEFAULT_SURVEY, sup);
  assert.equal(r.statusCode, 201); const id = r.json.survey.id; assert.equal(r.json.survey.updatedBy, 'boss');
  assert.equal((await call(h, 'POST', '/surveys', S.DEFAULT_SURVEY, agent('a'))).statusCode, 403);
  assert.equal((await call(h, 'POST', '/surveys', { name: 'x', questions: [] }, sup)).statusCode, 400);
  r = await call(h, 'PUT', '/surveys/' + id, { name: 'Renamed', status: 'paused' }, sup);
  assert.equal(r.json.survey.name, 'Renamed'); assert.equal(r.json.survey.status, 'paused'); assert.equal(r.json.survey.questions.length, 5, 'questions kept from the existing survey');
  assert.equal((await call(h, 'GET', '/surveys', null, agent('a'))).json.surveys.length, 1);
  assert.equal((await call(h, 'DELETE', '/surveys/' + id, null, sup)).statusCode, 200);
  assert.equal((await call(h, 'GET', '/surveys/' + id, null, sup)).statusCode, 404);
});

test('settings: defaults filled, secrets masked and preserved, numbers clamped; agents see only brand', async () => {
  const s = mem.make(); const h = api.makeHandler({ store: s });
  let r = await call(h, 'GET', '/settings', null, sup);
  assert.equal(r.json.settings.delivery.frequencyDays, 30); assert.equal(r.json.settings.closedLoop.attribute, 'csat');
  r = await call(h, 'PUT', '/settings', { arena: { ingestUrl: 'https://arena.test/api', key: 'ik_secret' }, delivery: { frequencyDays: 900, quietStart: 9 }, brand: { name: 'Acme', accent: 'red' }, connectInstanceId: 'inst-1' }, sup);
  assert.equal(r.json.settings.arena.key, '••••cret'); assert.equal(r.json.settings.delivery.frequencyDays, 365); assert.equal(r.json.settings.delivery.quietStart, 9); assert.equal(r.json.settings.brand.accent, '#0f766e');
  await call(h, 'PUT', '/settings', { arena: { ingestUrl: 'https://arena.test/api', key: '••••cret' } }, sup);
  assert.equal((await s.getSettings()).arena.key, 'ik_secret', 'masked value sent back keeps the secret');
  assert.equal((await s.getSettings()).connectInstanceId, 'inst-1');
  r = await call(h, 'GET', '/settings', null, agent('a')); assert.deepEqual(Object.keys(r.json.settings), ['brand']);
  assert.equal((await call(h, 'PUT', '/settings', {}, agent('a'))).statusCode, 403);
  const posts = []; const h2 = api.makeHandler({ store: s, post: async (u, b) => posts.push({ u, b }) });
  r = await call(h2, 'POST', '/settings/arena/test', { agent: 'arn:a' }, sup); assert.equal(r.statusCode, 200); assert.equal(posts[0].u, 'https://arena.test/api/ingest/ik_secret/events'); assert.equal(posts[0].b.events[0].type, 'CSAT_RECEIVED');
});

async function seeded() {
  const s = mem.make();
  const survey = S.normalizeSurvey(Object.assign({ id: 'default' }, S.DEFAULT_SURVEY)); await s.putSurvey(survey);
  const put = async (id, agentArn, queue, answers, status, at, channel) => { const scores = status === 'completed' ? S.scoreResponse(survey, answers) : undefined; await s.putResponse({ contactId: id, surveyId: 'default', agentArn, agentName: agentArn.split('/').pop(), queue, channel: channel || 'voice', status, answers, startedAt: at, completedAt: status === 'completed' ? at : undefined, scores, customerHash: 'h' + id, token: 't' + id }); };
  await put('c1', 'arn:a/ann', 'Billing', { csat: 5, resolved: 1, effort: 7, nps: 10 }, 'completed', '2026-10-01T10:00:00Z');
  await put('c2', 'arn:a/ann', 'Billing', { csat: 1, resolved: 0, effort: 1, nps: 0, why: 'rude' }, 'completed', '2026-10-05T10:00:00Z', 'chat');
  await put('c3', 'arn:a/bob', 'Sales', { csat: 4, resolved: 1, effort: 6, nps: 8 }, 'completed', '2026-10-09T10:00:00Z');
  await put('c4', 'arn:a/bob', 'Sales', {}, 'offered', '2026-10-10T10:00:00Z', 'sms');
  return s;
}

test('report, responses and CSV: supervisors see all, agents only their own; filters and range work', async () => {
  const s = await seeded(); const h = api.makeHandler({ store: s, now: () => new Date('2026-10-11T12:00:00Z') });
  let r = await call(h, 'GET', '/report', null, sup);
  assert.equal(r.json.from, '2026-09-12'); assert.equal(r.json.to, '2026-10-11'); assert.equal(r.json.overall.n, 3); assert.equal(r.json.overall.offered, 4); assert.equal(r.json.agents.length, 2); assert.equal(r.json.surveys[0].id, 'default');
  r = await call(h, 'GET', '/report', null, sup, { queue: 'Sales' }); assert.equal(r.json.overall.n, 1);
  r = await call(h, 'GET', '/report', null, sup, { from: '2026-10-05', to: '2026-10-09' }); assert.equal(r.json.overall.n, 2);
  r = await call(h, 'GET', '/report', null, agent('arn:a/ann')); assert.equal(r.json.overall.n, 2); assert.equal(r.json.agents.length, 1);
  r = await call(h, 'GET', '/responses', null, sup, { low: '1' }); assert.equal(r.json.responses.length, 1); assert.equal(r.json.responses[0].contactId, 'c2'); assert.equal(r.json.responses[0].customerHash, undefined); assert.equal(r.json.responses[0].token, undefined);
  r = await call(h, 'GET', '/responses', null, agent('arn:a/bob')); assert.deepEqual(r.json.responses.map((x) => x.contactId), ['c4', 'c3']);
  r = await call(h, 'GET', '/responses/c2', null, agent('arn:a/bob')); assert.equal(r.statusCode, 404);
  r = await call(h, 'GET', '/responses/c2', null, agent('arn:a/ann')); assert.equal(r.json.response.answers.why, 'rude'); assert.equal(r.json.survey.id, 'default');
  const csv = await h(req('GET', '/export.csv', null, sup));
  assert.match(csv.headers['content-type'], /text\/csv/); assert.equal(csv.body.trim().split('\n').length, 5);
  assert.equal((await h(req('GET', '/export.csv', null, agent('arn:a/ann')))).statusCode, 403);
  assert.equal((await call(h, 'GET', '/report', null, { 'cognito:groups': ['agents'] })).statusCode, 403);
});

test('privacy: delete by contact and by phone opts the customer out', async () => {
  const s = await seeded(); const h = api.makeHandler({ store: s });
  let r = await call(h, 'POST', '/privacy/delete', { contactId: 'c1' }, sup); assert.equal(r.json.removed, 1); assert.equal(await s.getResponse('c1'), null);
  const row = await s.getResponse('c2'); row.customerHash = s.customerHash('+15550100100'); await s.putResponse(row);
  r = await call(h, 'POST', '/privacy/delete', { phone: '+1 555 010 0100' }, sup); assert.equal(r.json.removed, 1); assert.equal(r.json.optedOut, true);
  assert.equal((await s.getCustomer(s.customerHash('+15550100100'))).optOut, true);
  assert.equal((await call(h, 'POST', '/privacy/delete', {}, sup)).statusCode, 400);
  assert.equal((await call(h, 'DELETE', '/responses/c3', null, sup)).statusCode, 200); assert.equal((await call(h, 'DELETE', '/responses/c3', null, sup)).statusCode, 404);
});

test('web survey: token lookup, partial saves, validation, completion, duplicate answers refused, opt-out', async () => {
  const s = await seeded(); const h = api.makeHandler({ store: s, now: () => new Date('2026-10-11T12:00:00Z') });
  await s.putToken('tc4', 'c4');
  let r = await call(h, 'GET', '/s/tc4'); assert.equal(r.statusCode, 200); assert.equal(r.json.next.id, 'csat'); assert.equal(r.json.survey.questions.length, 5); assert.ok((await s.getResponse('c4')).openedAt);
  assert.equal((await call(h, 'GET', '/s/nope')).statusCode, 404);
  r = await call(h, 'POST', '/s/tc4/answers', { answers: { csat: 9 } }); assert.equal(r.statusCode, 400); assert.match(r.json.errors.csat, /1 to 5/);
  r = await call(h, 'POST', '/s/tc4/answers', { answers: { csat: 2 } }); assert.equal(r.statusCode, 200); assert.equal(r.json.status, 'started'); assert.equal(r.json.next.id, 'resolved');
  r = await call(h, 'POST', '/s/tc4/answers', { answers: { resolved: 0, effort: 2, nps: 3 } }); assert.equal(r.json.next.id, 'why', 'low score asks why');
  r = await call(h, 'POST', '/s/tc4/answers', { answers: { why: 'Waited 40 minutes' } }); assert.equal(r.json.status, 'completed'); assert.equal(r.json.next, null);
  assert.equal((await s.getResponse('c4')).scores.low, true);
  r = await call(h, 'POST', '/s/tc4/answers', { answers: { csat: 5 } }); assert.equal(r.statusCode, 409);
  r = await call(h, 'POST', '/s/tc4/optout'); assert.equal(r.statusCode, 200); assert.equal((await s.getCustomer('hc4')).optOut, true);
  // the one-click email rating: the first answer arrives alone and is saved without completing
  await s.putResponse({ contactId: 'c5', surveyId: 'default', channel: 'email', status: 'offered', answers: {}, startedAt: '2026-10-11T09:00:00Z', token: 'tc5' }); await s.putToken('tc5', 'c5');
  r = await call(h, 'POST', '/s/tc5/answers', { answers: { csat: 4 }, finish: false }); assert.equal(r.json.status, 'started'); assert.equal(r.json.next.id, 'resolved');
});

test('ingest keys: contacts from another platform are invited; responses collected elsewhere are stored; data key reads', async () => {
  const s = mem.make(); await s.putSurvey(S.normalizeSurvey({ id: 'default', name: 'Default', target: { channels: ['sms', 'web', 'voice'] }, questions: [{ id: 'csat', type: 'rating', text: 'How did we do?' }] }));
  const h = api.makeHandler({ store: s, now: () => new Date('2026-10-11T12:00:00Z'), clients: {} });
  let r = await call(h, 'POST', '/keys', { kind: 'ingest', label: 'Genesys' }, sup); assert.equal(r.statusCode, 201); const ik = r.json.key; assert.match(ik, /^ik_/);
  r = await call(h, 'POST', '/keys', { kind: 'data' }, sup); const dk = r.json.key;
  r = await call(h, 'GET', '/keys', null, sup); assert.equal(r.json.keys.length, 2); assert.ok(r.json.keys.every((k) => k.key.endsWith('…')));
  assert.equal((await call(h, 'POST', '/ingest/bad/contacts', { contacts: [] })).statusCode, 401);
  r = await call(h, 'POST', '/ingest/' + ik + '/contacts', { contacts: [{ contactId: 'g1', channel: 'voice', agent: 'genesys-user-1', agentName: 'Gen Agent', queue: 'Support', phone: '+15550100100', platform: 'genesys' }, { contactId: 'g2' }, { channel: 'voice' }] });
  assert.equal(r.statusCode, 200); assert.equal(r.json.results[0].invited, true); assert.equal(r.json.results[0].channel, 'sms'); assert.equal(r.json.results[1].reason, 'no phone or email'); assert.equal(r.json.rejected[0].index, 2);
  assert.equal((await s.getResponse('g1')).platform, 'genesys'); assert.equal((await s.listAgents())[0].name, 'Gen Agent');
  r = await call(h, 'POST', '/ingest/' + ik + '/responses', { responses: [{ contactId: 'g3', agent: 'genesys-user-2', queue: 'Support', channel: 'chat', at: '2026-10-11T11:00:00Z', answers: { csat: 5 } }, { contactId: 'g3', answers: { csat: 1 } }, { contactId: 'g4' }] });
  assert.equal(r.json.accepted, 1); assert.equal(r.json.duplicates, 1); assert.equal(r.json.rejected.length, 1);
  assert.equal((await s.getResponse('g3')).scores.csat, 5); assert.equal((await s.getResponse('g3')).status, 'completed');
  r = await call(h, 'GET', '/data/' + dk + '/responses', null, null, { from: '2026-10-11', to: '2026-10-11' }); assert.equal(r.json.responses.length, 2); assert.equal(r.json.responses[0].token, undefined);
  assert.equal((await call(h, 'GET', '/data/' + ik + '/responses')).statusCode, 401, 'an ingest key cannot read');
  assert.equal((await call(h, 'DELETE', '/keys/' + ik, null, sup)).statusCode, 200);
  assert.equal((await call(h, 'POST', '/ingest/' + ik + '/contacts', { contacts: [] })).statusCode, 401);
});

test('partner API: invitations return a link the caller delivers, surveys are readable, report by data key, webhooks are signed', async () => {
  const s = mem.make(); await s.putSurvey(S.normalizeSurvey({ id: 'default', name: 'Default', questions: [{ id: 'csat', type: 'rating', text: 'How did we do?' }], lowScore: { threshold: 2 } }));
  await s.putSettings({ siteUrl: 'https://site.test', webhooks: [{ url: 'https://hooks.test/a', secret: 'shh', events: ['completed'] }, { url: 'https://hooks.test/low', secret: '', events: ['low'] }] });
  const posts = [];
  const h = api.makeHandler({ store: s, now: () => new Date('2026-10-11T12:00:00Z'), clients: {}, post: async (u, b, headers) => posts.push({ u, b, headers }) });
  const ik = (await call(h, 'POST', '/keys', { kind: 'ingest' }, sup)).json.key, dk = (await call(h, 'POST', '/keys', { kind: 'data' }, sup)).json.key;
  let r = await call(h, 'POST', '/ingest/' + ik + '/invitations', { contactId: 'v1', agent: 'vericx-agent-9', agentName: 'Vee', queue: 'Care', platform: 'vericx' });
  assert.equal(r.statusCode, 201); assert.match(r.json.url, /^https:\/\/site\.test\/survey\.html#t_/); assert.equal(r.json.surveyId, 'default');
  const token = r.json.token;
  assert.equal((await call(h, 'POST', '/ingest/' + ik + '/invitations', { contactId: 'v1' })).json.token, token, 'same contact, same link');
  assert.equal((await call(h, 'POST', '/ingest/' + ik + '/invitations', { contactId: 'v2', surveyId: 'nope' })).statusCode, 404);
  assert.equal((await call(h, 'POST', '/ingest/' + ik + '/invitations', {})).statusCode, 400);
  r = await call(h, 'GET', '/ingest/' + ik + '/surveys'); assert.equal(r.json.surveys.length, 1); assert.equal(r.json.surveys[0].questions[0].id, 'csat');
  assert.equal((await call(h, 'GET', '/ingest/' + dk + '/surveys')).statusCode, 401);
  // the vendor's own UI collects the answer and posts it through the web endpoints
  r = await call(h, 'POST', '/s/' + token + '/answers', { answers: { csat: 1 } });
  assert.equal(r.json.status, 'completed');
  assert.equal(posts.length, 2); assert.equal(posts[0].u, 'https://hooks.test/a'); assert.equal(posts[0].b.event, 'survey.completed.low'); assert.equal(posts[0].b.agent, 'vericx-agent-9');
  assert.match(posts[0].headers['x-surveycx-signature'], /^sha256=[0-9a-f]{64}$/); assert.deepEqual(posts[1].headers, {});
  // a good score does not reach the low-only hook
  await call(h, 'POST', '/ingest/' + ik + '/invitations', { contactId: 'v3' }); await call(h, 'POST', '/s/' + (await s.getResponse('v3')).token + '/answers', { answers: { csat: 5 } });
  assert.equal(posts.length, 3); assert.equal(posts[2].u, 'https://hooks.test/a');
  r = await call(h, 'GET', '/data/' + dk + '/report', null, null, { from: '2026-10-11', to: '2026-10-11' }); assert.equal(r.json.overall.n, 2); assert.equal(r.json.agents[0].id, 'vericx-agent-9');
  assert.equal((await call(h, 'GET', '/data/' + ik + '/report')).statusCode, 401);
  r = await call(h, 'PUT', '/settings', { webhooks: [{ url: 'https://hooks.test/a', secret: '••••shh', events: ['completed'] }, { url: 'http://insecure', secret: 'x' }] }, sup);
  assert.equal(r.json.settings.webhooks.length, 1, 'http dropped'); assert.equal(r.json.settings.webhooks[0].secret, '••••shh'); assert.equal((await s.getSettings()).webhooks[0].secret, 'shh', 'masked secret kept');
});
