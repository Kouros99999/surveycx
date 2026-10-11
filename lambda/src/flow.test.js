const assert = require('node:assert/strict');
const { test } = require('node:test');
const S = require('./surveycx-core.js');
const mem = require('./memstore.js');
const flow = require('./flow.js');
const contacts = require('./contacts.js');
const responses = require('./responses.js');

const connectEvent = (action, digits, over) => ({ Details: { ContactData: Object.assign({ ContactId: 'c-1', Channel: 'VOICE', Queue: { Name: 'Billing' }, Attributes: { tier: 'gold' }, CustomerEndpoint: { Type: 'TELEPHONE_NUMBER', Address: '+15550100100' } }, over || {}), Parameters: { action, digits } } });
const seed = async (s) => { await s.putSurvey(S.normalizeSurvey(Object.assign({ id: 'default', target: { queues: ['Billing'] } }, S.DEFAULT_SURVEY))); };

test('parseEvent reads the contact and the action', () => {
  const p = flow.parseEvent(connectEvent('answer', '4'));
  assert.equal(p.action, 'answer'); assert.equal(p.digits, '4'); assert.equal(p.contact.contactId, 'c-1'); assert.equal(p.contact.channel, 'voice'); assert.equal(p.contact.queue, 'Billing'); assert.equal(p.contact.phone, '+15550100100');
});

test('voice: start asks the first question, answers walk the survey, text is skipped, completion scores and closes the loop', async () => {
  const s = mem.make(); await seed(s);
  const sent = [];
  const clients = { connect: { send: async (c) => { sent.push(c); return {}; } }, UpdateContactAttributesCommand: function (i) { this.kind = 'attrs'; this.input = i; }, StartTaskContactCommand: function (i) { this.kind = 'task'; this.input = i; }, events: { send: async (c) => { sent.push(c); } }, PutEventsCommand: function (i) { this.kind = 'event'; this.input = i; } };
  const posts = [];
  await s.putSettings({ connectInstanceId: 'inst-1', closedLoop: { enabled: true, taskFlowId: 'flow-1' }, arena: { ingestUrl: 'https://arena.example/api', key: 'ik_x' } });
  const h = flow.makeHandler({ store: s, now: () => new Date('2026-10-11T10:00:00Z'), clients, post: async (url, body) => posts.push({ url, body }) });
  let r = await h(connectEvent('start'));
  assert.equal(r.eligible, 'true'); assert.equal(r.done, 'false'); assert.equal(r.question, 'csat'); assert.equal(r.digits, '1'); assert.match(r.prompt, /Press 1/); assert.match(r.intro, /Thank you/);
  r = await h(connectEvent('answer', '9'));
  assert.equal(r.retry, 'true'); assert.equal(r.question, 'csat'); assert.match(r.prompt, /valid answer/);
  r = await h(connectEvent('answer', '1')); assert.equal(r.question, 'resolved');
  r = await h(connectEvent('answer', '0')); assert.equal(r.question, 'effort');
  r = await h(connectEvent('answer', '2')); assert.equal(r.question, 'nps'); assert.equal(r.digits, '2'); assert.equal(r.two, 'true');
  r = await h(connectEvent('answer', '10'));
  assert.equal(r.done, 'true', 'free text is skipped on voice'); assert.match(r.outro, /Thank you/);
  const row = await s.getResponse('c-1');
  assert.equal(row.status, 'completed'); assert.equal(row.scores.csat, 1); assert.equal(row.scores.nps, 10); assert.equal(row.scores.low, true); assert.equal(row.scores.agentFive, 1);
  const attrs = sent.find((c) => c.kind === 'attrs').input; assert.equal(attrs.InitialContactId, 'c-1'); assert.equal(attrs.Attributes.csat, '1'); assert.equal(attrs.Attributes.surveycx_nps, '10'); assert.equal(attrs.Attributes.surveycx_low, 'true');
  const task = sent.find((c) => c.kind === 'task').input; assert.equal(task.ContactFlowId, 'flow-1'); assert.match(task.Name, /Low survey score/); assert.equal(task.PreviousContactId, 'c-1'); assert.match(task.Description, /Was your issue resolved\? 0/);
  assert.equal(sent.find((c) => c.kind === 'event').input.Entries[0].DetailType, 'Survey Completed - Low Score');
  assert.equal(posts.length, 0, 'no Arena post: the agent is not known in the disconnect flow');
  // The contact record arrives and names the agent: Arena then gets the score.
  const ingest = require('./ingest.js');
  const out = await ingest.processContact(s, contacts.fromContactRecord({ ContactId: 'c-1', Channel: 'VOICE', DisconnectTimestamp: '2026-10-11T10:05:00Z', Agent: { ARN: 'arn:agent/ann', Username: 'ann', FirstName: 'Ann', LastName: 'Lee' }, Queue: { Name: 'Billing' } }), Date.parse('2026-10-11T10:06:00Z'), { clients, post: async (url, body) => posts.push({ url, body }) });
  assert.equal(posts.length, 1); assert.equal(posts[0].body.events[0].type, 'CSAT_RECEIVED'); assert.equal(posts[0].body.events[0].agent, 'arn:agent/ann'); assert.equal(posts[0].body.events[0].score, 1);
  assert.equal(out.action, 'enriched');
  const after = await s.getResponse('c-1'); assert.equal(after.agentArn, 'arn:agent/ann'); assert.equal(after.agentName, 'Ann Lee');
  // start again on the same contact is refused
  assert.equal((await h(connectEvent('start'))).eligible, 'false');
});

test('start is not eligible without a matching survey or when sampled out', async () => {
  const s = mem.make(); await seed(s);
  const h = flow.makeHandler({ store: s });
  assert.equal((await h(connectEvent('start', '', { Queue: { Name: 'Sales' } }))).eligible, 'false');
  await s.putSurvey(S.normalizeSurvey({ id: 'default', name: 'x', target: { queues: ['Billing'], sample: 1 }, questions: [{ type: 'rating', text: 'a' }] }));
  const hits = []; for (let i = 0; i < 50; i++) hits.push((await h(connectEvent('start', '', { ContactId: 'z' + i }))).eligible);
  assert.ok(hits.filter((x) => x === 'true').length <= 5);
  assert.equal((await h(connectEvent('answer', '3', { ContactId: 'never' }))).eligible, 'false');
});

test('chat: prompts are typed, free text is asked on a low score and a dash skips it', async () => {
  const s = mem.make(); await seed(s);
  const h = flow.makeHandler({ store: s, clients: { } });
  let r = await h(connectEvent('start', '', { Channel: 'CHAT', CustomerEndpoint: undefined }));
  assert.match(r.prompt, /Reply with a number/);
  r = await h(connectEvent('answer', '2', { Channel: 'CHAT' })); r = await h(connectEvent('answer', '1', { Channel: 'CHAT' })); r = await h(connectEvent('answer', '7', { Channel: 'CHAT' })); r = await h(connectEvent('answer', '8', { Channel: 'CHAT' }));
  assert.equal(r.question, 'why'); assert.match(r.prompt, /dash/);
  r = await h(connectEvent('answer', '-', { Channel: 'CHAT' }));
  assert.equal(r.done, 'true');
  assert.equal((await s.getResponse('c-1')).answers.why, '');
});

test('responses.offer is idempotent and mints a token for web channels; complete is idempotent', async () => {
  const s = mem.make(); await seed(s);
  const survey = await s.getSurvey('default');
  const c = contacts.normalizeContact({ contactId: 'c-9', channel: 'voice', agent: 'arn:a', phone: '+15550100100' });
  const a = await responses.offer(s, c, survey, 'sms', '2026-10-11T10:00:00Z');
  const b = await responses.offer(s, c, survey, 'sms', '2026-10-11T10:00:01Z');
  assert.equal(a.token, b.token); assert.match(a.token, /^t_/); assert.equal(await s.getToken(a.token), 'c-9'); assert.ok(a.customerHash);
  await responses.answer(s, a, survey, 'csat', 5, '2026-10-11T10:01:00Z');
  const done = await responses.complete(s, a, survey, '2026-10-11T10:02:00Z', { clients: {} });
  assert.equal(done.status, 'completed'); assert.equal(done.scores.csat, 5);
  const again = await responses.complete(s, done, survey, '2026-10-11T11:00:00Z', { clients: {} });
  assert.equal(again.completedAt, '2026-10-11T10:02:00Z');
});
