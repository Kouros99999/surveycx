/*
 * Response lifecycle: offered -> started -> completed, with what happens on completion.
 *
 * Used by the Connect flow Lambda (IVR and in-chat), the web survey endpoints and the ingest route. On completion
 * the scores are computed and the closed loop runs: the score is written back to the contact as attributes, a
 * Connect Task is opened for a low score, an EventBridge event goes out, and Arena receives CSAT_RECEIVED.
 * Each of those is optional and a failure in one is logged, never thrown: the customer's answers are already saved.
 */
'use strict';
const S = require('./surveycx-core.js');
const crypto = require('crypto');

const newToken = () => 't_' + crypto.randomBytes(18).toString('base64url');

/** Create the response row for a contact that is about to be surveyed. Returns the row (existing one if already offered). */
async function offer(store, contact, survey, channel, nowIso, extra) {
  const existing = await store.getResponse(contact.contactId);
  if (existing) return existing;
  const row = Object.assign({ contactId: contact.contactId, surveyId: survey.id, channel, status: 'offered', startedAt: nowIso, answers: {},
    agentArn: contact.agent, agentName: contact.agentName, queue: contact.queue, platform: contact.platform || 'connect', tenant: contact.tenant || undefined, customerHash: store.customerHash(contact.phone || contact.email) || undefined,
    attributes: pickAttrs(contact.attributes) }, extra || {});
  if (channel === 'sms' || channel === 'email' || channel === 'web') row.token = newToken();
  await store.putResponse(row);
  if (row.token) await store.putToken(row.token, row.contactId, Date.parse(nowIso) + 14 * 86400000);
  if (contact.agent) await store.touchAgent(contact.agent, contact.agentName, contact.queue, nowIso);
  return row;
}
/** Only a few, short attributes travel with the response, for reports by attribute. */
function pickAttrs(attrs) { const out = {}; for (const k of Object.keys(attrs || {}).slice(0, 10)) out[k] = String(attrs[k]).slice(0, 100); return out; }

/** Record one answer. Returns { row, next } where next is the next question or null when the survey is complete. */
async function answer(store, row, survey, questionId, raw, nowIso) {
  const q = survey.questions.find((x) => x.id === questionId);
  if (!q) throw new Error('unknown question');
  const value = S.parseAnswer(q, raw);
  row.answers = Object.assign({}, row.answers, { [q.id]: value });
  if (row.status === 'offered') { row.status = 'started'; row.firstAnswerAt = nowIso; }
  const next = S.nextQuestion(survey, row.answers, row.channel === 'sms' || row.channel === 'email' ? 'web' : row.channel);
  await store.putResponse(row);
  return { row, next };
}

/** Mark a response complete, score it and run the closed loop. Idempotent. */
async function complete(store, row, survey, nowIso, deps) {
  if (row.status === 'completed') return row;
  row.status = 'completed'; row.completedAt = nowIso;
  row.scores = S.scoreResponse(survey, row.answers);
  await store.putResponse(row);
  if (row.customerHash) await store.touchCustomer(row.customerHash, { lastCompletedAt: nowIso });
  const settings = await store.getSettings();
  await closeLoop(row, survey, settings, deps || {});
  return row;
}

/** Everything that happens after a completed response. Each step is independent and never throws. */
async function closeLoop(row, survey, settings, deps) {
  const log = (what, err) => console.warn(JSON.stringify({ closeLoop: what, contactId: row.contactId, error: err && (err.name || err.message) }));
  const c = deps.clients || safeClients();
  const sc = row.scores || {};
  const cl = settings.closedLoop || {};
  // 1. Scores back onto the contact, so Contact Lens, the CTR and Arena's CTR path see them. Connect only; needs the instance.
  if (row.platform === 'connect' && c && c.connect && (settings.connectInstanceId || process.env.CONNECT_INSTANCE_ID)) {
    try {
      const attrs = { [cl.attribute || 'csat']: sc.agentFive != null ? String(sc.agentFive) : sc.five != null ? String(sc.five) : '', surveycx_survey: survey.id, surveycx_five: sc.five != null ? String(sc.five) : '' };
      if (sc.nps != null) attrs.surveycx_nps = String(sc.nps);
      if (sc.ces != null) attrs.surveycx_ces = String(sc.ces);
      if (sc.low) attrs.surveycx_low = 'true';
      for (const k of Object.keys(attrs)) if (attrs[k] === '') delete attrs[k];
      await c.connect.send(new c.UpdateContactAttributesCommand({ InstanceId: settings.connectInstanceId || process.env.CONNECT_INSTANCE_ID, InitialContactId: row.contactId, Attributes: attrs }));
    } catch (e) { log('attributes', e); }
  }
  // 2. Low score -> a Connect Task for a supervisor, with the answers in the description and a link to the contact.
  if (sc.low && cl.enabled !== false && cl.taskFlowId && row.platform === 'connect' && c && c.connect) {
    try {
      const lines = survey.questions.filter((q) => row.answers[q.id] !== undefined && row.answers[q.id] !== '').map((q) => `${q.text} ${q.type === 'choice' ? q.options[row.answers[q.id] - 1] : row.answers[q.id]}`);
      const instanceId = settings.connectInstanceId || process.env.CONNECT_INSTANCE_ID;
      const refs = {};
      if (instanceId && process.env.CONNECT_INSTANCE_URL) refs['Contact details'] = { Type: 'URL', Value: `${process.env.CONNECT_INSTANCE_URL.replace(/\/$/, '')}/contact-trace-records/details/${row.contactId}` };
      const siteUrl = process.env.SITE_URL || settings.siteUrl;
      if (siteUrl) refs['Survey response'] = { Type: 'URL', Value: `${siteUrl}/results.html#contact=${row.contactId}` };
      await c.connect.send(new c.StartTaskContactCommand({ InstanceId: instanceId, ContactFlowId: cl.taskFlowId, Name: `Low survey score: ${sc.five} of 5${row.agentName ? ' (' + row.agentName + ')' : ''}`,
        Description: `${survey.name}, ${row.channel}, queue ${row.queue || 'unknown'}.\n` + lines.join('\n').slice(0, 4000), References: refs, PreviousContactId: row.contactId, ClientToken: ('low-' + row.contactId).slice(0, 500),
        Attributes: { surveycx_contact: row.contactId, surveycx_five: String(sc.five), surveycx_agent: row.agentArn || '' } }));
    } catch (e) { log('task', e); }
  }
  // 3. An event per response for anything else the customer wants to wire up (Slack, CRM, warehouse).
  if (c && c.events) {
    try { await c.events.send(new c.PutEventsCommand({ Entries: [{ Source: 'surveycx', DetailType: sc.low ? 'Survey Completed - Low Score' : 'Survey Completed', Detail: JSON.stringify({ contactId: row.contactId, tenant: row.tenant, surveyId: survey.id, surveyName: survey.name, channel: row.channel, queue: row.queue, agent: row.agentArn, agentName: row.agentName, scores: sc, answers: row.answers, completedAt: row.completedAt }) }] })); }
    catch (e) { log('event', e); }
  }
  // 4. Webhooks for other apps: the whole response, signed so the receiver can verify it came from this stack.
  for (const w of settings.webhooks || []) {
    const wants = w.events || ['completed'];
    if (!w.url || !(wants.includes('completed') || (sc.low && wants.includes('low')))) continue;   // 'low' alone means only low scores
    try {
      const body = { event: sc.low ? 'survey.completed.low' : 'survey.completed', contactId: row.contactId, tenant: row.tenant, surveyId: survey.id, surveyName: survey.name, platform: row.platform, channel: row.channel, queue: row.queue, agent: row.agentArn, agentName: row.agentArn ? row.agentName : undefined, scores: sc, answers: row.answers, startedAt: row.startedAt, completedAt: row.completedAt };
      await (deps.post || exports.post)(w.url, body, w.secret ? { 'x-surveycx-signature': 'sha256=' + crypto.createHmac('sha256', w.secret).update(JSON.stringify(body)).digest('hex') } : {});
    } catch (e) { log('webhook', e); }
  }
  // 5. Arena: the agent-attributable score as CSAT_RECEIVED through its ingest endpoint.
  const ar = settings.arena || {};
  if (ar.ingestUrl && ar.key && row.agentArn && (sc.agentFive != null || sc.five != null)) {
    try {
      const post = deps.post || exports.post;
      await post(ar.ingestUrl.replace(/\/$/, '') + '/ingest/' + encodeURIComponent(ar.key) + '/events', { events: [{ type: 'CSAT_RECEIVED', agent: row.agentArn, contactId: row.contactId, score: sc.agentFive != null ? sc.agentFive : sc.five, at: row.completedAt, source: 'surveycx' }] });
    } catch (e) { log('arena', e); }
  }
}

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const https = require('https'); const u = new URL(url); const data = JSON.stringify(body);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': 'SurveyCX' }, headers || {}), timeout: 5000 }, (res) => { res.resume(); res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error('status ' + res.statusCode)))); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.write(data); req.end();
  });
}

let clients;
function realClients() {
  if (clients) return clients;
  const cn = require('@aws-sdk/client-connect'), eb = require('@aws-sdk/client-eventbridge');
  clients = { connect: new cn.ConnectClient({}), UpdateContactAttributesCommand: cn.UpdateContactAttributesCommand, StartTaskContactCommand: cn.StartTaskContactCommand, events: new eb.EventBridgeClient({}), PutEventsCommand: eb.PutEventsCommand };
  return clients;
}

exports.offer = offer; exports.answer = answer; exports.complete = complete; exports.closeLoop = closeLoop; exports.newToken = newToken; exports.post = post; exports.realClients = realClients;
/** The real AWS clients, or null when the SDK is not installed (local dev server, tests). */
function safeClients() { try { return realClients(); } catch (e) { console.warn('closeLoop: AWS SDK not available, skipping attributes, tasks and events'); return null; } }
