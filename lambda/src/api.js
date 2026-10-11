/*
 * SurveyCX API. One Lambda behind an HTTP API (payload v2), served under /api on the site's CloudFront.
 *
 * Signed in (JWT authorizer; supervisors group may do everything, agents see their own results):
 *   GET/POST /surveys, GET/PUT/DELETE /surveys/{id}        the survey builder (supervisors)
 *   GET/PUT /settings                                     closed loop, delivery, Arena feed, brand; secrets come back masked (supervisors)
 *   POST /settings/arena/test                             sends a test CSAT_RECEIVED to Arena (supervisors)
 *   GET /report?from&to[&surveyId][&agent][&queue]        aggregate by agent, queue, driver, day, channel, plus the newest verbatim themes (agents: own rows only, no themes)
 *   GET /responses?from&to[&surveyId][&agent][&queue][&low=1]  the rows behind the report (agents: own rows only)
 *   GET /responses/{contactId}, DELETE /responses/{contactId}   one response; delete removes it (supervisors)
 *   GET /export.csv?from&to                               CSV download (supervisors)
 *   POST /privacy/delete { phone | email | contactId }    delete everything about a customer or a contact (supervisors)
 *   GET /agents                                           agents seen so far
 *   GET/POST /keys, DELETE /keys/{key}                    ingest and data keys for other platforms and BI tools (supervisors); { tenant } binds a key to one tenant:
 *                                                         everything an ingest key creates carries it, a data key only reads it, and a key without a tenant sees everything
 * Public (the token or key in the path is the credential):
 *   GET  /s/{token}                                       the survey for a web link (questions, brand); answers so far
 *   POST /s/{token}/answers { answers: { qid: value } }   save answers; completes when every required question is answered
 *   POST /s/{token}/optout                                never survey this customer again
 *   POST /ingest/{key}/contacts { contacts: [...] }       any platform reports finished contacts (contacts.js shape); invitations go out
 *   POST /ingest/{key}/responses { responses: [...] }     answers collected elsewhere: { contactId, surveyId?, agent?, queue?, channel?, answers }
 *   POST /ingest/{key}/invitations { contactId, agent?, queue?, channel?, phone?, email?, surveyId?, deliver? }
 *                                                         a survey link for a contact that the caller delivers itself (its own chat widget, SMS or app); deliver: true sends it as usual
 *   GET  /ingest/{key}/surveys                            the active survey definitions, for an app that renders the questions itself
 *   GET  /data/{key}/responses?from&to                    read API for warehouses and BI tools
 *   GET  /data/{key}/report?from&to[&surveyId][&queue][&agent]  the aggregate the results page shows
 *   Webhooks (settings.webhooks): every completed response is POSTed as JSON, signed with X-SurveyCX-Signature (HMAC-SHA256 of the body)
 *   GET  /health
 */
'use strict';
const S = require('./surveycx-core.js');
const storeMod = require('./store.js');
const clock = require('./clock.js');
const contacts = require('./contacts.js');
const responses = require('./responses.js');
const delivery = require('./delivery.js');

const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PLATFORM = process.env.PROVIDER || 'connect';
const VERSION = process.env.SURVEYCX_VERSION || '0.0.0-dev';   // stamped by the release build; partners read it from /health and the data report
const MAX_DAYS = 92;
const json = (status, body, extra) => ({ statusCode: status, headers: Object.assign({ 'content-type': 'application/json', 'access-control-allow-origin': ORIGIN, 'cache-control': 'no-store' }, extra || {}), body: JSON.stringify(body) });

function route(method, path) {
  const m = (re) => path.match(re); let x;
  if (method === 'GET' && path === '/health') return { name: 'health' };
  if (method === 'GET' && path === '/surveys') return { name: 'listSurveys' };
  if (method === 'POST' && path === '/surveys') return { name: 'createSurvey' };
  if (method === 'GET' && (x = m(/^\/surveys\/([^/]+)$/))) return { name: 'getSurvey', id: decodeURIComponent(x[1]) };
  if (method === 'PUT' && (x = m(/^\/surveys\/([^/]+)$/))) return { name: 'putSurvey', id: decodeURIComponent(x[1]) };
  if (method === 'DELETE' && (x = m(/^\/surveys\/([^/]+)$/))) return { name: 'deleteSurvey', id: decodeURIComponent(x[1]) };
  if (method === 'GET' && path === '/settings') return { name: 'getSettings' };
  if (method === 'PUT' && path === '/settings') return { name: 'putSettings' };
  if (method === 'POST' && path === '/settings/arena/test') return { name: 'testArena' };
  if (method === 'GET' && path === '/report') return { name: 'report' };
  if (method === 'GET' && path === '/responses') return { name: 'listResponses' };
  if (method === 'GET' && (x = m(/^\/responses\/([^/]+)$/))) return { name: 'getResponse', id: decodeURIComponent(x[1]) };
  if (method === 'DELETE' && (x = m(/^\/responses\/([^/]+)$/))) return { name: 'deleteResponse', id: decodeURIComponent(x[1]) };
  if (method === 'GET' && path === '/export.csv') return { name: 'exportCsv' };
  if (method === 'POST' && path === '/privacy/delete') return { name: 'privacyDelete' };
  if (method === 'GET' && path === '/agents') return { name: 'agents' };
  if (method === 'GET' && path === '/keys') return { name: 'listKeys' };
  if (method === 'POST' && path === '/keys') return { name: 'createKey' };
  if (method === 'DELETE' && (x = m(/^\/keys\/([^/]+)$/))) return { name: 'deleteKey', key: decodeURIComponent(x[1]) };
  if (method === 'GET' && (x = m(/^\/s\/([^/]+)$/))) return { name: 'webSurvey', token: decodeURIComponent(x[1]), public: true };
  if (method === 'POST' && (x = m(/^\/s\/([^/]+)\/answers$/))) return { name: 'webAnswers', token: decodeURIComponent(x[1]), public: true };
  if (method === 'POST' && (x = m(/^\/s\/([^/]+)\/optout$/))) return { name: 'webOptout', token: decodeURIComponent(x[1]), public: true };
  if (method === 'POST' && (x = m(/^\/ingest\/([^/]+)\/contacts$/))) return { name: 'ingestContacts', key: decodeURIComponent(x[1]), public: true };
  if (method === 'POST' && (x = m(/^\/ingest\/([^/]+)\/responses$/))) return { name: 'ingestResponses', key: decodeURIComponent(x[1]), public: true };
  if (method === 'POST' && (x = m(/^\/ingest\/([^/]+)\/invitations$/))) return { name: 'ingestInvitations', key: decodeURIComponent(x[1]), public: true };
  if (method === 'GET' && (x = m(/^\/ingest\/([^/]+)\/surveys$/))) return { name: 'ingestSurveys', key: decodeURIComponent(x[1]), public: true };
  if (method === 'GET' && (x = m(/^\/data\/([^/]+)\/report$/))) return { name: 'dataReport', key: decodeURIComponent(x[1]), public: true };
  if (method === 'GET' && (x = m(/^\/data\/([^/]+)\/responses$/))) return { name: 'dataResponses', key: decodeURIComponent(x[1]), public: true };
  return null;
}

const SECRET_KEYS = ['key'];
/** Settings as the console sees them: secrets masked, defaults filled in. */
function publicSettings(s) {
  const out = JSON.parse(JSON.stringify(s || {}));
  out.delivery = Object.assign({}, delivery.DEFAULTS, out.delivery || {});
  out.closedLoop = Object.assign({ enabled: true, attribute: 'csat', taskFlowId: '' }, out.closedLoop || {});
  out.arena = Object.assign({ ingestUrl: '' }, out.arena || {});
  if (out.arena.key) out.arena.key = '••••' + String(out.arena.key).slice(-4);
  out.webhooks = (out.webhooks || []).map((w) => Object.assign({}, w, { secret: w.secret ? '••••' + String(w.secret).slice(-4) : '' }));
  out.brand = Object.assign({ name: '', accent: '#0f766e', logoUrl: '' }, out.brand || {});
  out.analysis = Object.assign({ sentiment: true, available: process.env.VERBATIM_ANALYSIS === 'enabled' }, out.analysis || {});
  return out;
}
/** Merge a settings update, keeping a secret when the client sent back the masked value. */
function mergeSettings(cur, body) {
  const out = JSON.parse(JSON.stringify(cur || {}));
  for (const section of ['delivery', 'closedLoop', 'arena', 'brand', 'analysis']) if (body[section] && typeof body[section] === 'object') out[section] = Object.assign({}, out[section] || {}, body[section]);
  // Webhooks: up to 5 { url, secret, events: ['completed','low'] }; a masked secret sent back keeps the stored one. HTTPS only.
  if (Array.isArray(body.webhooks)) out.webhooks = body.webhooks.slice(0, 5).map((w, i) => { const prev = ((cur && cur.webhooks) || [])[i] || {}; const url = String((w && w.url) || '').trim().slice(0, 500); let secret = String((w && w.secret) || '').trim().slice(0, 200); if (secret.startsWith('••••')) secret = prev.secret || ''; const events = Array.isArray(w && w.events) ? w.events.filter((e) => e === 'completed' || e === 'low') : []; return { url, secret, events: events.length ? events : ['completed'], label: String((w && w.label) || '').slice(0, 60) }; }).filter((w) => /^https:\/\//.test(w.url));
  if (body.connectInstanceId !== undefined) out.connectInstanceId = String(body.connectInstanceId || '').trim().slice(0, 100);
  if (body.siteUrl !== undefined) out.siteUrl = String(body.siteUrl || '').trim().replace(/\/$/, '').slice(0, 200);
  if (out.arena && typeof out.arena.key === 'string' && out.arena.key.startsWith('••••')) out.arena.key = (cur && cur.arena && cur.arena.key) || '';
  if (out.delivery) { for (const k of ['frequencyDays', 'quietStart', 'quietEnd', 'reminderHours']) if (out.delivery[k] !== undefined) out.delivery[k] = Math.max(0, Math.min(k === 'frequencyDays' ? 365 : k === 'reminderHours' ? 168 : 24, +out.delivery[k] || 0)); }
  if (out.brand) { out.brand.name = String(out.brand.name || '').slice(0, 60); if (out.brand.accent && !/^#[0-9a-f]{6}$/i.test(out.brand.accent)) out.brand.accent = '#0f766e'; out.brand.logoUrl = String(out.brand.logoUrl || '').slice(0, 300); }
  return out;
}

function makeHandler(deps) {
  const s = deps.store || storeMod, now = deps.now || (() => new Date());
  const rangeOf = (q) => { const today = clock.dayKey(now()); const to = clock.isDay(q.to) && q.to <= today ? q.to : today; let from = clock.isDay(q.from) ? q.from : clock.addDays(to, -29); if (from > to) from = to; if (clock.addDays(from, MAX_DAYS - 1) < to) from = clock.addDays(to, 1 - MAX_DAYS); return { from, to }; };
  const filterRows = (rows, q, claims) => rows.filter((r) => (!q.surveyId || r.surveyId === q.surveyId) && (!q.queue || r.queue === q.queue) && (!q.agent || r.agentArn === q.agent) && (!q.tenant || r.tenant === q.tenant) && (!q.low || (r.scores && r.scores.low)) && (isSupervisor(claims) || r.agentArn === claims['custom:agentArn']));
  /** A response visible to an agent hides the customer's free text? No: agents see their own feedback whole, but never the customer hash or token. */
  const forViewer = (r, claims) => { const { customerHash, token, ...rest } = r; return isSupervisor(claims) ? rest : Object.assign(rest, { attributes: undefined }); };
  const keyOf = async (key, kind) => { const k = await s.getKey(key); return k && k.kind === kind && !(k.expiresAt && k.expiresAt < now().toISOString()) ? k : null; };

  return async (event) => {
    const method = event.requestContext && event.requestContext.http ? event.requestContext.http.method : event.httpMethod;
    const path = event.rawPath || event.path || '/';
    const qs = event.queryStringParameters || {};
    const claims = (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt && event.requestContext.authorizer.jwt.claims) || {};
    if (method === 'OPTIONS') return json(204, {});
    const r = route(method, path);
    if (!r) return json(404, { error: 'not found' });
    const sup = isSupervisor(claims);
    try {
      switch (r.name) {
        case 'health': return json(200, { ok: true, at: now().toISOString(), platform: PLATFORM, version: VERSION, partner: process.env.PARTNER || undefined, releaseNotes: 'https://surveycx.ai/releases.html', feed: 'https://surveycx.ai/releases.xml' });
        case 'listSurveys': return json(200, { surveys: await s.listSurveys() });
        case 'getSurvey': { const x = await s.getSurvey(r.id); return x ? json(200, { survey: x }) : json(404, { error: 'not found' }); }
        case 'createSurvey': case 'putSurvey': {
          if (!sup) return json(403, { error: 'supervisors only' });
          const cur = r.id ? await s.getSurvey(r.id) : null;
          if (r.id && !cur) return json(404, { error: 'not found' });
          let survey;
          try { survey = S.normalizeSurvey(Object.assign({}, parse(event), r.id ? { id: r.id } : {}), cur); } catch (e) { return json(400, { error: e.message }); }
          survey.updatedAt = now().toISOString(); survey.createdAt = (cur && cur.createdAt) || survey.updatedAt; survey.updatedBy = who(claims);
          await s.putSurvey(survey);
          console.info(JSON.stringify({ audit: r.name, by: who(claims), survey: survey.id }));
          return json(r.id ? 200 : 201, { survey });
        }
        case 'deleteSurvey': { if (!sup) return json(403, { error: 'supervisors only' }); await s.deleteSurvey(r.id); console.info(JSON.stringify({ audit: 'deleteSurvey', by: who(claims), survey: r.id })); return json(200, { deleted: r.id }); }
        case 'getSettings': return sup ? json(200, { settings: publicSettings(await s.getSettings()) }) : json(200, { settings: { brand: publicSettings(await s.getSettings()).brand } });
        case 'putSettings': {
          if (!sup) return json(403, { error: 'supervisors only' });
          const merged = mergeSettings(await s.getSettings(), parse(event));
          await s.putSettings(merged);
          console.info(JSON.stringify({ audit: 'putSettings', by: who(claims) }));
          return json(200, { settings: publicSettings(merged) });
        }
        case 'testArena': {
          if (!sup) return json(403, { error: 'supervisors only' });
          const st = await s.getSettings(), ar = st.arena || {};
          if (!ar.ingestUrl || !ar.key) return json(400, { error: 'set the Arena ingest URL and key first' });
          const b = parse(event), agent = String(b.agent || '').trim();
          if (!agent) return json(400, { error: 'send { agent } : the Arena agent id to credit the test score to' });
          try { await (deps.post || responses.post)(ar.ingestUrl.replace(/\/$/, '') + '/ingest/' + encodeURIComponent(ar.key) + '/events', { events: [{ type: 'CSAT_RECEIVED', agent, contactId: 'surveycx-test-' + now().getTime(), score: 5, at: now().toISOString(), source: 'surveycx-test' }] }); }
          catch (e) { return json(502, { error: 'Arena did not accept the event: ' + e.message }); }
          return json(200, { ok: true });
        }
        case 'report': case 'listResponses': case 'exportCsv': {
          if (r.name === 'exportCsv' && !sup) return json(403, { error: 'supervisors only' });
          if (!sup && !claims['custom:agentArn']) return json(403, { error: 'your sign-in has no agent id' });
          const { from, to } = rangeOf(qs);
          const rows = filterRows(await s.responsesBetween(from, to), qs, claims);
          const surveys = await s.listSurveys();
          if (r.name === 'report') return json(200, Object.assign({ from, to, surveys: surveys.map((x) => ({ id: x.id, name: x.name, status: x.status })), themes: sup ? await s.getThemes(qs.surveyId || '*', to) : undefined }, S.aggregate(rows, surveys)));
          if (r.name === 'listResponses') return json(200, { from, to, responses: rows.slice(-1000).reverse().map((x) => forViewer(x, claims)) });
          return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="surveycx-${from}-${to}.csv"`, 'access-control-allow-origin': ORIGIN, 'cache-control': 'no-store' }, body: S.toCsv(rows, surveys) };
        }
        case 'getResponse': {
          const x = await s.getResponse(r.id);
          if (!x || (!sup && x.agentArn !== claims['custom:agentArn'])) return json(404, { error: 'not found' });
          return json(200, { response: forViewer(x, claims), survey: await s.getSurvey(x.surveyId) });
        }
        case 'deleteResponse': { if (!sup) return json(403, { error: 'supervisors only' }); const ok = await s.deleteResponse(r.id); console.info(JSON.stringify({ audit: 'deleteResponse', by: who(claims), contactId: r.id })); return ok ? json(200, { deleted: r.id }) : json(404, { error: 'not found' }); }
        case 'privacyDelete': {
          if (!sup) return json(403, { error: 'supervisors only' });
          const b = parse(event); let removed = 0;
          if (b.contactId) { if (await s.deleteResponse(String(b.contactId))) removed++; }
          const hash = s.customerHash(b.phone || b.email);
          if (hash) { for (const row of await s.responsesForCustomer(hash)) { await s.deleteResponse(row.contactId); removed++; } await s.touchCustomer(hash, { optOut: true, optOutAt: now().toISOString(), optOutVia: 'privacy', lastInvitedAt: null }); }
          if (!b.contactId && !hash) return json(400, { error: 'send a contactId, a phone or an email' });
          console.info(JSON.stringify({ audit: 'privacyDelete', by: who(claims), removed }));
          return json(200, { removed, optedOut: !!hash });
        }
        case 'agents': { const list = await s.listAgents(); return json(200, { agents: sup ? list : list.filter((a) => a.arn === claims['custom:agentArn']) }); }
        case 'listKeys': { if (!sup) return json(403, { error: 'supervisors only' }); return json(200, { keys: (await s.listKeys()).map((k) => ({ key: k.key.slice(0, 6) + '…', kind: k.kind, label: k.label, tenant: k.tenant, createdAt: k.createdAt, createdBy: k.createdBy, expiresAt: k.expiresAt, id: k.key })) }); }
        case 'createKey': {
          if (!sup) return json(403, { error: 'supervisors only' });
          const b = parse(event), kind = b.kind === 'data' ? 'data' : 'ingest', key = (kind === 'ingest' ? 'ik_' : 'dk_') + require('crypto').randomBytes(24).toString('base64url');
          const days = Math.min(3650, Math.max(1, +(b.days || 365)));
          const meta = { kind, label: String(b.label || (kind === 'ingest' ? 'Platform connector' : 'Warehouse')).slice(0, 60), tenant: String(b.tenant || '').trim().slice(0, 80) || undefined, createdAt: now().toISOString(), createdBy: who(claims), expiresAt: new Date(now().getTime() + days * 86400000).toISOString() };
          await s.putKey(key, meta);
          return json(201, Object.assign({ key }, meta));   // the only time the full key is shown
        }
        case 'deleteKey': { if (!sup) return json(403, { error: 'supervisors only' }); await s.deleteKey(r.key); return json(200, { deleted: true }); }

        // ---------- public: web survey ----------
        case 'webSurvey': case 'webAnswers': case 'webOptout': {
          const contactId = await s.getToken(r.token);
          const row = contactId && await s.getResponse(contactId);
          if (!row) return json(404, { error: 'This survey link is not valid or has expired.' });
          const survey = await s.getSurvey(row.surveyId);
          if (!survey) return json(410, { error: 'This survey is no longer running.' });
          const brand = publicSettings(await s.getSettings()).brand;
          if (r.name === 'webOptout') { if (row.customerHash) await s.touchCustomer(row.customerHash, { optOut: true, optOutAt: now().toISOString(), optOutVia: 'web' }); return json(200, { ok: true, message: 'You will not receive survey invitations from us again.' }); }
          const view = () => ({ survey: { id: survey.id, name: survey.name, intro: survey.intro, outro: survey.outro, language: survey.language, questions: survey.questions }, brand, status: row.status, answers: row.answers || {}, next: row.status === 'completed' ? null : S.nextQuestion(survey, row.answers, 'web') });
          if (r.name === 'webSurvey') { if (row.status === 'offered') { row.openedAt = row.openedAt || now().toISOString(); await s.putResponse(row); } return json(200, view()); }
          if (row.status === 'completed') return json(409, Object.assign({ error: 'This survey has already been answered. Thank you.' }, view()));
          const b = parse(event), answers = (b && typeof b.answers === 'object' && b.answers) || {};
          const errors = {};
          for (const qid of Object.keys(answers)) {
            const q = survey.questions.find((x) => x.id === qid); if (!q) continue;
            try { await responses.answer(s, row, survey, qid, answers[qid], now().toISOString()); } catch (e) { errors[qid] = e.message; }
          }
          if (Object.keys(errors).length) return json(400, Object.assign({ errors }, view()));
          if (!S.nextQuestion(survey, row.answers, 'web') && (b.finish !== false)) await responses.complete(s, row, survey, now().toISOString(), deps);
          return json(200, view());
        }

        // ---------- public: other platforms ----------
        case 'ingestContacts': {
          const ik = await keyOf(r.key, 'ingest'); if (!ik) return json(401, { error: 'ingest key is invalid or expired' });
          const b = parse(event), list = Array.isArray(b.contacts) ? b.contacts : Array.isArray(b) ? b : null;
          if (!list) return json(400, { error: 'send { contacts: [...] }' });
          if (list.length > 200) return json(413, { error: 'at most 200 contacts per call' });
          const settings = await s.getSettings(), surveys = await s.listSurveys(), results = [], rejected = [];
          for (let i = 0; i < list.length; i++) {
            let c;
            try { c = contacts.normalizeContact(Object.assign({}, list[i], ik.tenant ? { tenant: ik.tenant } : {}), now().toISOString()); } catch (e) { rejected.push({ index: i, error: e.message }); continue; }
            if (c.agent) await s.touchAgent(c.agent, c.agentName, c.queue, now().toISOString());
            results.push(Object.assign({ contactId: c.contactId }, await delivery.considerOutbound(s, c, settings, surveys, now().getTime())));
          }
          return json(rejected.length && !results.length ? 400 : 200, { results, rejected });
        }
        case 'ingestResponses': {
          const ik = await keyOf(r.key, 'ingest'); if (!ik) return json(401, { error: 'ingest key is invalid or expired' });
          const b = parse(event), list = Array.isArray(b.responses) ? b.responses : null;
          if (!list) return json(400, { error: 'send { responses: [...] }' });
          if (list.length > 200) return json(413, { error: 'at most 200 responses per call' });
          const surveys = await s.listSurveys(); let accepted = 0, duplicates = 0; const rejected = [];
          for (let i = 0; i < list.length; i++) {
            const e = list[i] || {};
            try {
              const c = contacts.normalizeContact({ contactId: e.contactId, channel: e.channel && contacts.CHANNELS.includes(e.channel) ? e.channel : 'voice', agent: e.agent, agentName: e.agentName, queue: e.queue, attributes: e.attributes, platform: e.platform, endedAt: e.at, tenant: ik.tenant || e.tenant }, now().toISOString());
              const survey = (e.surveyId && surveys.find((x) => x.id === e.surveyId)) || S.pickSurvey(surveys.map((x) => Object.assign({}, x, { target: Object.assign({}, x.target, { channels: S.CHANNELS }) })), c);
              if (!survey) throw new Error('no survey matches; send surveyId');
              if (!e.answers || typeof e.answers !== 'object') throw new Error('answers is required');
              if (await s.getResponse(c.contactId)) { duplicates++; continue; }
              const at = e.at ? new Date(e.at).toISOString() : now().toISOString();
              const row = await responses.offer(s, c, survey, e.channel && S.CHANNELS.includes(e.channel) ? e.channel : 'web', at, { platform: c.platform });
              for (const q of survey.questions) if (e.answers[q.id] !== undefined) await responses.answer(s, row, survey, q.id, e.answers[q.id], at);
              await responses.complete(s, row, survey, at, deps);
              accepted++;
            } catch (err) { rejected.push({ index: i, error: err.message }); }
          }
          return json(rejected.length && !accepted ? 400 : 200, { accepted, duplicates, rejected });
        }
        case 'ingestInvitations': {
          const ik = await keyOf(r.key, 'ingest'); if (!ik) return json(401, { error: 'ingest key is invalid or expired' });
          const b = parse(event);
          let c;
          try { c = contacts.normalizeContact({ contactId: b.contactId, tenant: ik.tenant || b.tenant, channel: b.channel && contacts.CHANNELS.includes(b.channel) ? b.channel : 'voice', agent: b.agent, agentName: b.agentName, queue: b.queue, attributes: b.attributes, phone: b.phone, email: b.email, platform: b.platform, endedAt: b.endedAt }, now().toISOString()); } catch (e) { return json(400, { error: e.message }); }
          const surveys = await s.listSurveys(), settings = await s.getSettings();
          if (b.deliver === true) return json(200, Object.assign({ contactId: c.contactId }, await delivery.considerOutbound(s, c, settings, surveys, now().getTime())));
          // The caller delivers the link itself: no channel rules, no sending; opt-out still applies to a known address.
          const survey = b.surveyId ? surveys.find((x) => x.id === b.surveyId && x.status === 'active') : S.pickSurvey(surveys.map((x) => Object.assign({}, x, { target: Object.assign({}, x.target, { channels: S.CHANNELS }) })), c);
          if (!survey) return json(404, { error: b.surveyId ? 'no active survey with that id' : 'no active survey matches this contact; send surveyId' });
          const hash = s.customerHash(c.phone || c.email), cust = await s.getCustomer(hash);
          if (cust && cust.optOut) return json(200, { contactId: c.contactId, invited: false, reason: 'opted out' });
          if (c.agent) await s.touchAgent(c.agent, c.agentName, c.queue, now().toISOString());
          const row = await responses.offer(s, c, survey, 'web', now().toISOString(), { customerHash: hash || undefined, platform: c.platform });
          if (!row.token) return json(409, { error: 'this contact was already surveyed in another channel' });
          if (hash) await s.touchCustomer(hash, { lastInvitedAt: now().toISOString(), channel: 'web' });
          const siteUrl = process.env.SITE_URL || settings.siteUrl || '';
          return json(201, { contactId: c.contactId, surveyId: survey.id, token: row.token, url: `${siteUrl}/survey.html#${row.token}`, expiresAt: new Date(now().getTime() + 14 * 86400000).toISOString(), status: row.status });
        }
        case 'ingestSurveys': {
          if (!(await keyOf(r.key, 'ingest'))) return json(401, { error: 'ingest key is invalid or expired' });
          return json(200, { surveys: (await s.listSurveys()).filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, language: x.language, target: x.target, intro: x.intro, outro: x.outro, questions: x.questions, lowScore: x.lowScore })) });
        }
        case 'dataReport': {
          const dk = await keyOf(r.key, 'data'); if (!dk) return json(401, { error: 'data key is invalid or expired' });
          const { from, to } = rangeOf(qs), tenant = dk.tenant || qs.tenant;
          const surveys = await s.listSurveys();
          const rows = (await s.responsesBetween(from, to)).filter((x) => (!qs.surveyId || x.surveyId === qs.surveyId) && (!qs.queue || x.queue === qs.queue) && (!qs.agent || x.agentArn === qs.agent) && (!tenant || x.tenant === tenant));
          return json(200, Object.assign({ from, to, tenant, version: VERSION, surveys: surveys.map((x) => ({ id: x.id, name: x.name, status: x.status })), themes: tenant ? undefined : await s.getThemes(qs.surveyId || '*', to) }, S.aggregate(rows, surveys)));
        }
        case 'dataResponses': {
          const dk = await keyOf(r.key, 'data'); if (!dk) return json(401, { error: 'data key is invalid or expired' });
          const { from, to } = rangeOf(qs), tenant = dk.tenant || qs.tenant;
          return json(200, { from, to, tenant, responses: (await s.responsesBetween(from, to)).filter((x) => !tenant || x.tenant === tenant).map((x) => { const { customerHash, token, ...rest } = x; return rest; }) });
        }
        default: return json(404, { error: 'not found' });
      }
    } catch (err) {
      console.error(err);
      return json(500, { error: 'internal' });
    }
  };
}

function parse(event) { try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || '{}'); } catch { return {}; } }
const who = (claims) => claims.name || claims['cognito:username'] || claims.username || claims.sub || 'supervisor';
function isSupervisor(claims) {
  const groups = claims['cognito:groups'] || claims.groups || [];
  const list = Array.isArray(groups) ? groups : String(groups).replace(/[\[\]]/g, '').split(/[ ,]+/);
  return list.includes('supervisors') || process.env.AUTH_MODE === 'none';
}

exports.route = route; exports.publicSettings = publicSettings; exports.mergeSettings = mergeSettings; exports.makeHandler = makeHandler; exports.handler = makeHandler({});
