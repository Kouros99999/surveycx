const assert = require('node:assert/strict');
const { test } = require('node:test');
const S = require('./surveycx-core.js');
const mem = require('./memstore.js');
const d = require('./delivery.js');
const contacts = require('./contacts.js');
const ingest = require('./ingest.js');
const optout = require('./optout.js');

const survey = (over) => S.normalizeSurvey(Object.assign({ id: 'default', name: 'Default', questions: [{ type: 'rating', text: 'How did we do?' }] }, over || {}));
const T = (iso) => Date.parse(iso);

test('nextSendTime respects the quiet window (UTC stack)', () => {
  assert.equal(d.nextSendTime(T('2026-10-11T12:00:00Z'), 8, 21), T('2026-10-11T12:00:00Z'));
  assert.equal(d.nextSendTime(T('2026-10-11T03:00:00Z'), 8, 21), T('2026-10-11T08:00:00Z'));
  assert.equal(d.nextSendTime(T('2026-10-11T22:30:00Z'), 8, 21), T('2026-10-12T08:00:00Z'));
});

test('considerOutbound: picks a channel, honours sampling, frequency cap, opt-out and queues the invite', async () => {
  const s = mem.make(); await s.putSurvey(survey({ target: { channels: ['voice', 'sms', 'email'] } }));
  const surveys = await s.listSurveys();
  const c = contacts.normalizeContact({ contactId: 'c1', channel: 'voice', agent: 'arn:a', phone: '+15550100100', email: 'ann@example.com' });
  let r = await d.considerOutbound(s, c, {}, surveys, T('2026-10-11T12:00:00Z'));
  assert.equal(r.invited, true); assert.equal(r.channel, 'sms'); assert.equal(r.dueAt, '2026-10-11T12:00:00.000Z');
  const row = await s.getResponse('c1'); assert.equal(row.channel, 'sms'); assert.ok(row.token); assert.equal(row.status, 'offered');
  assert.equal((await s.dueSends('2026-10-11T12:00:00.000Z')).length, 1);
  // same customer, another contact the next day: capped
  const c2 = contacts.normalizeContact({ contactId: 'c2', channel: 'voice', agent: 'arn:a', phone: '+1 (555) 010-0100' });
  r = await d.considerOutbound(s, c2, {}, surveys, T('2026-10-12T12:00:00Z')); assert.equal(r.invited, false); assert.match(r.reason, /within 30 days/);
  r = await d.considerOutbound(s, c2, { delivery: { frequencyDays: 0 } }, surveys, T('2026-10-12T12:00:00Z')); assert.equal(r.invited, true);
  // opted out
  await s.touchCustomer(s.customerHash('+15550100100'), { optOut: true });
  r = await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'c3', channel: 'voice', agent: 'arn:a', phone: '+15550100100' }), { delivery: { frequencyDays: 0 } }, surveys, T('2026-10-13T12:00:00Z'));
  assert.equal(r.invited, false); assert.equal(r.reason, 'opted out');
  // email only survey with a phone-only contact
  const s2 = mem.make(); await s2.putSurvey(survey({ target: { channels: ['email'] } }));
  r = await d.considerOutbound(s2, c2, {}, await s2.listSurveys(), T('2026-10-11T12:00:00Z')); assert.equal(r.invited, false);
  r = await d.considerOutbound(s2, c, {}, await s2.listSurveys(), T('2026-10-11T12:00:00Z')); assert.equal(r.channel, 'email');
  // quiet hours queue for the morning
  const s3 = mem.make(); await s3.putSurvey(survey({ target: { channels: ['sms'] } }));
  r = await d.considerOutbound(s3, c2, {}, await s3.listSurveys(), T('2026-10-11T23:00:00Z')); assert.equal(r.dueAt, '2026-10-12T08:00:00.000Z');
  assert.equal((await d.considerOutbound(s3, contacts.normalizeContact({ contactId: 'c4', channel: 'voice', agent: 'arn:a' }), {}, [], T('2026-10-11T23:00:00Z'))).reason, 'no phone or email');
});

test('sendDue sends SMS and email with the link, drops completed ones, queues one reminder, records failures', async () => {
  const s = mem.make(); await s.putSurvey(survey({ target: { channels: ['sms', 'email'] } }));
  const surveys = await s.listSurveys(), now = T('2026-10-11T12:00:00Z');
  await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'p1', channel: 'voice', agent: 'arn:a', phone: '+15550100101' }), {}, surveys, now);
  await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'e1', channel: 'voice', agent: 'arn:a', email: 'bob@example.com' }), {}, surveys, now);
  await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'x1', channel: 'voice', agent: 'arn:a', phone: '+15550100102' }), {}, surveys, now);
  const done = await s.getResponse('x1'); done.status = 'completed'; await s.putResponse(done);
  const sms = [], mails = [];
  const clients = { sms: { send: async (c) => sms.push(c.input) }, SendTextMessageCommand: function (i) { this.input = i; }, ses: { send: async (c) => mails.push(c.input) }, SendEmailCommand: function (i) { this.input = i; } };
  const settings = { brand: { name: 'Acme' }, delivery: { reminderHours: 24, smsOrigination: '+15550000000', emailFrom: 'care@acme.test' } };
  let r = await d.sendDue(s, settings, clients, now, 'https://site.test');
  assert.deepEqual(r, { sent: 2, dropped: 1, reminders: 2 });
  assert.equal(sms[0].DestinationPhoneNumber, '+15550100101'); assert.match(sms[0].MessageBody, /^Acme: .*https:\/\/site\.test\/survey\.html#t_.*STOP/); assert.equal(sms[0].MessageType, 'TRANSACTIONAL');
  assert.equal(mails[0].Destination.ToAddresses[0], 'bob@example.com'); assert.match(mails[0].Content.Simple.Body.Html.Data, /survey\.html#t_[A-Za-z0-9_-]+&a=5/);
  assert.equal((await s.getResponse('p1')).sends, 1);
  // reminders are due in 24h, within the window, and only for still-unanswered responses
  const due = await s.dueSends('2026-10-12T12:00:00.000Z'); assert.equal(due.length, 2); assert.ok(due.every((x) => x.kind === 'reminder'));
  const p1 = await s.getResponse('p1'); p1.status = 'started'; await s.putResponse(p1);
  r = await d.sendDue(s, settings, clients, T('2026-10-12T12:00:00Z'), 'https://site.test');
  assert.equal(r.sent, 1); assert.equal(r.dropped, 1); assert.equal(r.reminders, 0);
  // a failing send is recorded on the row and not retried forever
  await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'f1', channel: 'voice', agent: 'arn:a', phone: '+15550100103' }), { delivery: { frequencyDays: 0 } }, surveys, T('2026-10-13T12:00:00Z'));
  r = await d.sendDue(s, settings, { sms: { send: async () => { throw new Error('boom'); } }, SendTextMessageCommand: function (i) { this.input = i; } }, T('2026-10-13T12:00:00Z'), 'https://site.test');
  assert.equal(r.dropped, 1); assert.equal((await s.getResponse('f1')).sendError, 'boom');
});

test('fromContactRecord maps a Connect CTR and survives a bad address; ingest enriches or invites', async () => {
  const ctr = { ContactId: 'c1', Channel: 'VOICE', DisconnectTimestamp: '2026-10-11T10:00:00Z', Agent: { ARN: 'arn:a', Username: 'ann' }, Queue: { Name: 'Billing' }, CustomerEndpoint: { Type: 'TELEPHONE_NUMBER', Address: '+15550100100' }, Attributes: { email: 'ann@example.com', tier: 'gold' } };
  const c = contacts.fromContactRecord(ctr, 'email');
  assert.equal(c.channel, 'voice'); assert.equal(c.agent, 'arn:a'); assert.equal(c.agentName, 'ann'); assert.equal(c.phone, '+15550100100'); assert.equal(c.email, 'ann@example.com'); assert.equal(c.attributes.tier, 'gold'); assert.equal(c.platform, 'connect');
  assert.equal(contacts.fromContactRecord(Object.assign({}, ctr, { CustomerEndpoint: { Type: 'TELEPHONE_NUMBER', Address: 'anonymous' } })).phone, undefined);
  assert.equal(contacts.fromContactRecord({ ContactId: 'x' }), null);
  assert.throws(() => contacts.normalizeContact({ contactId: 'x', channel: 'fax' }), /channel must be/);
  const s = mem.make(); await s.putSurvey(survey({ target: { channels: ['sms'] } }));
  const h = ingest.makeHandler({ store: s, now: () => T('2026-10-11T12:00:00Z') });
  const rec = (o) => ({ kinesis: { sequenceNumber: '1', data: Buffer.from(JSON.stringify(o)).toString('base64') } });
  const out = await h({ Records: [rec(ctr), rec({ ContactId: 'noagent', Channel: 'VOICE', DisconnectTimestamp: '2026-10-11T10:00:00Z' }), rec(Object.assign({}, ctr, { ContactId: 't1', Channel: 'TASK' }))] });
  assert.deepEqual(out.batchItemFailures, []);
  assert.equal((await s.getResponse('c1')).channel, 'sms'); assert.equal(await s.getResponse('noagent'), null); assert.equal(await s.getResponse('t1'), null);
  assert.equal((await s.listAgents())[0].name, 'ann');
});

test('optout parses End User Messaging inbound SMS and marks STOP senders', async () => {
  const s = mem.make();
  const h = optout.makeHandler({ store: s });
  const rec = (body, from) => ({ Sns: { Message: JSON.stringify({ originationNumber: from || '+15550100100', destinationNumber: '+15550000000', messageBody: body }) } });
  const r = await h({ Records: [rec('STOP'), rec('thanks, great service'), rec('Unsubscribe me', '+15550100199'), { Sns: { Message: 'not json' } }] });
  assert.equal(r.optedOut, 2);
  assert.equal((await s.getCustomer(s.customerHash('+15550100100'))).optOut, true);
  assert.equal(await s.getCustomer(s.customerHash('+15550100150')), null);
  assert.equal(optout.parseRecord(rec('stop')).stop, true); assert.equal(optout.parseRecord(rec('stopping by later')).stop, false);
});

test('quiet hours follow the customer\'s zone from their phone number; unknown numbers use the stack zone', async () => {
  const { zoneOf } = require('./phonezone.js');
  assert.equal(zoneOf('+12125551234'), 'America/New_York'); assert.equal(zoneOf('+1 (310) 555-1234'), 'America/Los_Angeles'); assert.equal(zoneOf('+447700900123'), 'Europe/London'); assert.equal(zoneOf('+61400000000'), null, 'multi-zone country'); assert.equal(zoneOf(''), null);
  // 23:00 UTC is 16:00 in Los Angeles: inside the window, so a Californian is texted now; a Londoner waits until 08:00 London time.
  assert.equal(d.nextSendTime(T('2026-10-11T23:00:00Z'), 8, 21, 'America/Los_Angeles'), T('2026-10-11T23:00:00Z'));
  assert.equal(d.nextSendTime(T('2026-10-11T23:00:00Z'), 8, 21, 'Europe/London'), T('2026-10-12T07:00:00Z'));
  const s = mem.make(); await s.putSurvey(survey({ target: { channels: ['sms'] } }));
  const r = await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'la', channel: 'voice', agent: 'arn:a', phone: '+13105551234' }), {}, await s.listSurveys(), T('2026-10-11T23:00:00Z'));
  assert.equal(r.dueAt, '2026-10-11T23:00:00.000Z');
  const uk = await d.considerOutbound(s, contacts.normalizeContact({ contactId: 'uk', channel: 'voice', agent: 'arn:a', phone: '+447700900123' }), {}, await s.listSurveys(), T('2026-10-11T23:00:00Z'));
  assert.equal(uk.dueAt, '2026-10-12T07:00:00.000Z');
  assert.equal((await s.dueSends('2026-10-12T08:00:00.000Z')).find((x) => x.contactId === 'uk').tz, 'Europe/London');
});
