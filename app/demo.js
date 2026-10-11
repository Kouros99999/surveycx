/* Website demo: runs the real API handler in the browser over an in-memory store, so the pages work without a stack. Loaded by common.js when config says demo. */
(function () {
  'use strict';
  // The Lambda API code needs a CommonJS environment; a tiny shim gives it one for the modules it requires.
  const modules = {};
  const define = (name, body) => { modules[name] = body; };
  window.SurveyCXDemo = { ready: false };
  const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  (async function () {
    await load('demo-seed.js');
    const store = memStore();
    await SurveyCXSeed.seed(store);
    const claims = { 'cognito:groups': ['supervisors'], 'cognito:username': 'demo' };
    const S = window.SurveyCX;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = new URL(url, location.href);
      if (!u.pathname.includes('/api/')) return realFetch(url, opts);
      const path = u.pathname.slice(u.pathname.indexOf('/api/') + 4), method = (opts && opts.method) || 'GET', body = opts && opts.body ? JSON.parse(opts.body) : {};
      const r = await route(method, path, Object.fromEntries(u.searchParams), body);
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.csv ? 'text/csv' : 'application/json', 'content-disposition': r.csv ? 'attachment; filename="surveycx-demo.csv"' : '' } });
    };
    window.SurveyCXDemo.ready = true;

    // A small subset of api.js, enough for the three pages. Mirrors its shapes.
    async function route(method, path, qs, body) {
      const ok = (b) => ({ status: 200, body: b }), bad = (s, e) => ({ status: s, body: { error: e } });
      const rows = async () => { const to = qs.to || new Date().toISOString().slice(0, 10), from = qs.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10); return { from, to, list: (await store.responsesBetween(from, to)).filter((r) => (!qs.surveyId || r.surveyId === qs.surveyId) && (!qs.queue || r.queue === qs.queue) && (!qs.agent || r.agentArn === qs.agent) && (!qs.low || (r.scores && r.scores.low))) }; };
      let m;
      if (path === '/surveys' && method === 'GET') return ok({ surveys: await store.listSurveys() });
      if (path === '/surveys' && method === 'POST') { try { const s = S.normalizeSurvey(body); s.updatedAt = new Date().toISOString(); s.updatedBy = 'demo'; await store.putSurvey(s); return { status: 201, body: { survey: s } }; } catch (e) { return bad(400, e.message); } }
      if ((m = path.match(/^\/surveys\/([^/]+)$/))) { const id = decodeURIComponent(m[1]); const cur = await store.getSurvey(id); if (!cur) return bad(404, 'not found'); if (method === 'DELETE') { await store.deleteSurvey(id); return ok({ deleted: id }); } if (method === 'PUT') { try { const s = S.normalizeSurvey(Object.assign({}, body, { id }), cur); s.updatedAt = new Date().toISOString(); s.updatedBy = 'demo'; await store.putSurvey(s); return ok({ survey: s }); } catch (e) { return bad(400, e.message); } } return ok({ survey: cur }); }
      if (path === '/settings') { if (method === 'PUT') { const cur = await store.getSettings(); for (const k of ['delivery', 'closedLoop', 'arena', 'brand']) if (body[k]) cur[k] = Object.assign({}, cur[k] || {}, body[k]); await store.putSettings(cur); } const s = await store.getSettings(); return ok({ settings: { delivery: Object.assign({ frequencyDays: 30, quietStart: 8, quietEnd: 21, reminderHours: 0, smsText: '{brand}: thanks for contacting us today. Could you answer 3 quick questions? {link} Reply STOP to opt out.', emailSubject: 'How did we do today?', emailText: 'Thank you for contacting {brand}. Please take a minute to tell us how we did: {link}' }, s.delivery || {}), closedLoop: Object.assign({ enabled: true, attribute: 'csat', taskFlowId: '' }, s.closedLoop || {}), arena: Object.assign({ ingestUrl: '' }, s.arena || {}, s.arena && s.arena.key ? { key: '••••' + s.arena.key.slice(-4) } : {}), brand: Object.assign({ name: '', accent: '#0f766e', logoUrl: '' }, s.brand || {}), connectInstanceId: s.connectInstanceId || '' } }); }
      if (path === '/settings/arena/test') return ok({ ok: true });
      if (path === '/report') { const { from, to, list } = await rows(); const surveys = await store.listSurveys(); return ok(Object.assign({ from, to, surveys: surveys.map((x) => ({ id: x.id, name: x.name, status: x.status })), themes: await store.getThemes('*', to) }, S.aggregate(list, surveys))); }
      if (path === '/responses') { const { from, to, list } = await rows(); return ok({ from, to, responses: list.slice(-1000).reverse() }); }
      if ((m = path.match(/^\/responses\/([^/]+)$/))) { const r = await store.getResponse(decodeURIComponent(m[1])); if (!r) return bad(404, 'not found'); if (method === 'DELETE') { await store.deleteResponse(r.contactId); return ok({ deleted: r.contactId }); } return ok({ response: r, survey: await store.getSurvey(r.surveyId) }); }
      if (path === '/export.csv') { const { list } = await rows(); return { status: 200, csv: true, body: S.toCsv(list, await store.listSurveys()) }; }
      if (path === '/privacy/delete') return ok({ removed: 0, optedOut: false });
      if (path === '/agents') return ok({ agents: await store.listAgents() });
      if (path === '/keys' && method === 'GET') return ok({ keys: [{ id: 'ik_demo', key: 'ik_dem…', kind: 'ingest', label: 'Genesys (demo)', createdAt: '2026-10-01', createdBy: 'demo', expiresAt: '2027-10-01' }] });
      if (path === '/keys' && method === 'POST') return { status: 201, body: { key: 'ik_demo_' + Math.random().toString(36).slice(2), kind: body.kind, label: body.label } };
      if (path.startsWith('/keys/')) return ok({ deleted: true });
      if ((m = path.match(/^\/s\/([^/]+)(\/answers|\/optout)?$/))) {
        const contactId = await store.getToken(decodeURIComponent(m[1])); const r = contactId && await store.getResponse(contactId); if (!r) return bad(404, 'This survey link is not valid or has expired.');
        const survey = await store.getSurvey(r.surveyId), brand = (await store.getSettings()).brand;
        const view = () => ({ survey, brand, status: r.status, answers: r.answers, next: r.status === 'completed' ? null : S.nextQuestion(survey, r.answers, 'web') });
        if (m[2] === '/optout') return ok({ ok: true, message: 'You will not receive survey invitations from us again.' });
        if (!m[2]) return ok(view());
        if (r.status === 'completed') return { status: 409, body: Object.assign({ error: 'This survey has already been answered. Thank you.' }, view()) };
        const errors = {};
        for (const k of Object.keys(body.answers || {})) { const q = survey.questions.find((x) => x.id === k); if (!q) continue; try { r.answers[k] = S.parseAnswer(q, body.answers[k]); r.status = 'started'; } catch (e) { errors[k] = e.message; } }
        if (Object.keys(errors).length) return { status: 400, body: Object.assign({ errors }, view()) };
        if (!S.nextQuestion(survey, r.answers, 'web') && body.finish !== false) { r.status = 'completed'; r.completedAt = new Date().toISOString(); r.scores = S.scoreResponse(survey, r.answers); }
        await store.putResponse(r); return ok(view());
      }
      return bad(404, 'not found');
    }
  })();

  /** The in-memory store, same shape as lambda/src/memstore.js, for the browser. */
  function memStore() {
    const surveys = new Map(), responses = new Map(), tokens = new Map(), agents = new Map(), themes = new Map(); let settings = {};
    const dayOf = (iso) => String(iso).slice(0, 10);
    return {
      async listSurveys() { return [...surveys.values()]; }, async getSurvey(id) { return surveys.get(id) || null; }, async putSurvey(s) { surveys.set(s.id, s); }, async deleteSurvey(id) { surveys.delete(id); },
      async getSettings() { return settings; }, async putSettings(s) { settings = s; },
      async getResponse(id) { return responses.get(id) || null; }, async putResponse(r) { responses.set(r.contactId, Object.assign({}, r)); },
      async responsesBetween(from, to) { return [...responses.values()].filter((r) => dayOf(r.startedAt) >= from && dayOf(r.startedAt) <= to).sort((a, b) => a.startedAt.localeCompare(b.startedAt)); },
      async deleteResponse(id) { return responses.delete(id); },
      async putToken(t, id) { tokens.set(t, id); }, async getToken(t) { return tokens.get(t) || null; },
      async touchAgent(arn, name, queue, at) { agents.set(arn, { arn, name, queue, lastSeen: at }); }, async listAgents() { return [...agents.values()]; },
      async touchCustomer() {}, async getCustomer() { return null; },
      async putThemes(id, day, d) { themes.set(id + '#' + day, d); }, async getThemes(id, day) { const k = [...themes.keys()].filter((x) => x.startsWith(id + '#') && x.slice(id.length + 1) <= day).sort(); return k.length ? themes.get(k[k.length - 1]) : null; },
    };
  }
})();
