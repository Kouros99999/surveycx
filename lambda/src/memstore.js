/*
 * In-memory implementation of the store for tests and the local dev server. Same functions, same shapes.
 */
'use strict';
const clock = require('./clock.js');
const real = require('./store.js');

function make() {
  const surveys = new Map(), responses = new Map(), tokens = new Map(), customers = new Map(), outbox = new Map(), keys = new Map(), agents = new Map(), meters = new Map();
  let settings = {};
  return {
    responseItem: real.responseItem, customerHash: real.customerHash, strip: real.strip, RETENTION_DAYS: real.RETENTION_DAYS,
    async listSurveys() { return [...surveys.values()]; }, async getSurvey(id) { return surveys.get(id) || null; }, async putSurvey(s) { surveys.set(s.id, s); }, async deleteSurvey(id) { surveys.delete(id); },
    async getSettings() { return settings; }, async putSettings(s) { settings = s; },
    async getResponse(id) { return responses.get(id) || null; }, async putResponse(r, nowMs) { responses.set(r.contactId, real.strip(real.responseItem(r, nowMs))); },
    async responsesBetween(from, to) { return [...responses.values()].filter((r) => { const d = clock.dayKey(r.startedAt); return d >= from && d <= to; }).sort((a, b) => a.startedAt.localeCompare(b.startedAt)); },
    async deleteResponse(id) { const r = responses.get(id); if (r && r.token) tokens.delete(r.token); return responses.delete(id); },
    async responsesForCustomer(hash) { return [...responses.values()].filter((r) => r.customerHash === hash); },
    async putToken(t, contactId) { tokens.set(t, contactId); }, async getToken(t) { return tokens.get(t) || null; },
    async getCustomer(h) { return (h && customers.get(h)) || null; }, async touchCustomer(h, patch) { if (h) customers.set(h, Object.assign(customers.get(h) || {}, patch)); },
    async enqueue(s) { outbox.set(s.dueAt + '#' + s.contactId, s); }, async dueSends(nowIso) { return [...outbox.entries()].filter(([k]) => k <= nowIso + '#~').map(([sk, v]) => Object.assign({}, v, { sk })); }, async deleteSend(sk) { outbox.delete(sk); },
    async listKeys() { return [...keys.entries()].map(([key, m]) => Object.assign({ key }, m)); }, async getKey(k) { return keys.get(k) || null; }, async putKey(k, m) { keys.set(k, m); }, async deleteKey(k) { keys.delete(k); },
    async touchAgent(arn, name, queue, at) { if (!arn) return; const cur = agents.get(arn) || {}; agents.set(arn, { name: name || cur.name || arn.split('/').pop(), queue: queue || 'unassigned', lastSeen: at }); }, async listAgents() { return [...agents.entries()].map(([arn, a]) => Object.assign({ arn }, a)); },
    async getMeter(d) { return meters.get(d) || null; }, async putMeter(d, v) { meters.set(d, v); },
    _dump: () => ({ surveys, responses, tokens, customers, outbox, keys, agents, meters, settings }),
  };
}
module.exports = { make };
