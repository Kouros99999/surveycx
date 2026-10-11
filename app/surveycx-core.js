/*
 * SurveyCX core: the survey model, validation, question flow, scoring and aggregation.
 *
 * Pure functions shared by the Lambdas and the pages (UMD). Nothing here touches AWS or the DOM, so the same
 * code decides the next IVR prompt in the Connect flow, renders the web survey, and builds the results page.
 *
 * A survey:
 *   { id, name, status: 'active'|'paused', language, target: { queues: [names], attribute: { name, value } | null, channels: ['voice','chat','sms','email'] },
 *     intro, outro, questions: [ { id, type, text, driver?, agentAttributable?, options?, required?, skipUnless? } ],
 *     lowScore: { enabled, threshold (1-5 scale), question: id | 'any' } }
 *
 * Question types and the scale each answers on:
 *   rating    1-5          CSAT        agent or company
 *   nps       0-10         NPS         company
 *   ces       1-7          CES         company (how easy was it)
 *   yesno     1 = yes, 0 = no
 *   choice    1..n         one of options[]
 *   text      free text    (voice: skipped unless a transcription is available)
 *
 * Every answered score is also normalised to 1-5 ("five") so surveys with different scales report together, and
 * so Arena receives one scale. A response: { surveyId, contactId, channel, answers: { [qid]: value }, startedAt, completedAt }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurveyCX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = { rating: { min: 1, max: 5 }, nps: { min: 0, max: 10 }, ces: { min: 1, max: 7 }, yesno: { min: 0, max: 1 }, choice: { min: 1, max: 9 }, text: {} };
  const CHANNELS = ['voice', 'chat', 'sms', 'email', 'web'];
  const MAX_QUESTIONS = 10;
  const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max || 300);
  const slug = (s) => str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'q';

  /** Bring a score on its own scale to 1-5. NPS 0-10 and CES 1-7 are linear; yes/no is 5 or 1. */
  function toFive(type, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (type === 'rating') return clamp(n, 1, 5);
    if (type === 'nps') return 1 + (clamp(n, 0, 10) / 10) * 4;
    if (type === 'ces') return 1 + ((clamp(n, 1, 7) - 1) / 6) * 4;
    if (type === 'yesno') return n ? 5 : 1;
    return null;
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const round1 = (n) => Math.round(n * 10) / 10;

  /** Validate and normalise a survey as a supervisor saved it. Throws with a message a person can act on. */
  function normalizeSurvey(input, existing) {
    const s = Object.assign({}, existing || {}, input || {});
    const out = { id: str(s.id, 60) || slug(s.name) + '-' + Math.random().toString(36).slice(2, 7), name: str(s.name, 120), status: s.status === 'paused' ? 'paused' : 'active', language: str(s.language, 12) || 'en-US' };
    if (!out.name) throw new Error('the survey needs a name');
    const t = s.target || {};
    const queues = Array.isArray(t.queues) ? t.queues.map((q) => str(q, 120)).filter(Boolean).slice(0, 50) : [];
    const attr = t.attribute && str(t.attribute.name, 120) ? { name: str(t.attribute.name, 120), value: str(t.attribute.value, 200) } : null;
    const channels = (Array.isArray(t.channels) ? t.channels : CHANNELS).map((c) => str(c, 10)).filter((c) => CHANNELS.includes(c));
    if (!channels.length) throw new Error('pick at least one channel');
    out.target = { queues, attribute: attr, channels, sample: clamp(Number.isFinite(+t.sample) ? +t.sample : 100, 1, 100) };
    out.intro = str(s.intro, 400) || 'Thank you for contacting us. Please answer a few short questions about your experience.';
    out.outro = str(s.outro, 400) || 'Thank you for your feedback. Goodbye.';
    const qs = Array.isArray(s.questions) ? s.questions : [];
    if (!qs.length) throw new Error('add at least one question');
    if (qs.length > MAX_QUESTIONS) throw new Error(`at most ${MAX_QUESTIONS} questions; short surveys get answered`);
    const ids = new Set();
    out.questions = qs.map((q, i) => {
      const type = str(q.type, 10);
      if (!TYPES[type]) throw new Error(`question ${i + 1}: type must be one of ${Object.keys(TYPES).join(', ')}`);
      const text = str(q.text, 400);
      if (!text) throw new Error(`question ${i + 1} needs its text`);
      let id = str(q.id, 40) || slug(text).slice(0, 24) + '-' + (i + 1);
      if (ids.has(id)) id = id + '-' + (i + 1);
      ids.add(id);
      // Agent-attributable scores feed agent reports and Arena; company questions (NPS, effort, resolution) do not count against the agent.
      const scored = type !== 'text' && type !== 'choice';
      const o = { id, type, text, driver: str(q.driver, 60) || undefined, agentAttributable: scored ? (q.agentAttributable !== undefined ? !!q.agentAttributable : type === 'rating') : undefined, required: type === 'text' ? q.required === true : q.required !== false };   // free text is optional unless asked for
      if (type === 'choice') {
        const options = (Array.isArray(q.options) ? q.options : []).map((x) => str(x, 80)).filter(Boolean).slice(0, 9);
        if (options.length < 2) throw new Error(`question ${i + 1}: a choice question needs 2 to 9 options`);
        o.options = options;
      }
      // One skip rule: ask this question only when an earlier score was at or below a value on its own scale.
      if (q.skipUnless && str(q.skipUnless.question, 40)) {
        const ref = qs.slice(0, i).find((p) => str(p.id, 40) === str(q.skipUnless.question, 40));
        if (!ref) throw new Error(`question ${i + 1}: the skip rule must point at an earlier question`);
        o.skipUnless = { question: str(q.skipUnless.question, 40), atMost: Number.isFinite(+q.skipUnless.atMost) ? +q.skipUnless.atMost : 3 };
      }
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
      return o;
    });
    const l = s.lowScore || {};
    out.lowScore = { enabled: l.enabled !== false, threshold: clamp(Number.isFinite(+l.threshold) ? +l.threshold : 2, 1, 5), question: str(l.question, 40) || 'any' };
    out.createdAt = s.createdAt; out.updatedAt = s.updatedAt;
    return out;
  }

  /**
   * Which active survey applies to a contact. The most specific wins: attribute match, then queue match, then a
   * survey with no target at all (the default). Channel must be allowed. Pure.
   */
  function pickSurvey(surveys, contact) {
    const ch = contact.channel || 'voice';
    const live = (surveys || []).filter((s) => s.status === 'active' && s.target.channels.includes(ch));
    const attrs = contact.attributes || {};
    const byAttr = live.find((s) => s.target.attribute && attrs[s.target.attribute.name] != null && (s.target.attribute.value === '' || String(attrs[s.target.attribute.name]) === s.target.attribute.value));
    if (byAttr) return byAttr;
    const byQueue = live.find((s) => contact.queue && s.target.queues.includes(contact.queue));
    if (byQueue) return byQueue;
    return live.find((s) => !s.target.queues.length && !s.target.attribute) || null;
  }

  /** Deterministic sampling: the same contact id always lands on the same side of the percentage. */
  function sampled(contactId, percent) {
    if (percent >= 100) return true;
    let h = 0; const s = String(contactId || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return (h % 100) < percent;
  }

  /** The next question to ask given the answers so far, honouring skip rules and the channel. null when done. */
  function nextQuestion(survey, answers, channel) {
    answers = answers || {};
    for (const q of survey.questions) {
      if (answers[q.id] !== undefined) continue;
      if (q.type === 'text' && channel === 'voice') continue;              // no spoken comments on the IVR yet
      if (q.skipUnless) {
        const ref = survey.questions.find((p) => p.id === q.skipUnless.question);
        const v = ref ? Number(answers[ref.id]) : NaN;
        if (!Number.isFinite(v) || v > q.skipUnless.atMost) continue;      // the earlier score was fine, no need to ask why
      }
      return q;
    }
    return null;
  }

  /** Validate one answer for a question; returns the stored value or throws. '' means skipped (allowed when not required). */
  function parseAnswer(q, raw) {
    if (raw === '' || raw == null) { if (q.required) throw new Error('an answer is required'); return ''; }
    if (q.type === 'text') return str(raw, 2000);
    const n = Number(raw);
    const r = TYPES[q.type];
    const max = q.type === 'choice' ? q.options.length : r.max;
    if (!Number.isInteger(n) || n < r.min || n > max) throw new Error(`answer must be a whole number from ${r.min} to ${max}`);
    return n;
  }

  /** The spoken or shown prompt for a question on the IVR: text plus how to answer. */
  function voicePrompt(q) {
    if (q.type === 'rating') return `${q.text} Press 1 for very dissatisfied up to 5 for very satisfied.`;
    if (q.type === 'nps') return `${q.text} Press a number from 0 to 9, or press 1 then 0 for 10.`;
    if (q.type === 'ces') return `${q.text} Press 1 for very difficult up to 7 for very easy.`;
    if (q.type === 'yesno') return `${q.text} Press 1 for yes or 0 for no.`;
    if (q.type === 'choice') return `${q.text} ${q.options.map((o, i) => `Press ${i + 1} for ${o}.`).join(' ')}`;
    return q.text;
  }
  /** Max DTMF digits for a question, so the flow knows when to stop listening. */
  const voiceDigits = (q) => (q.type === 'nps' ? 2 : 1);
  /** The same question typed into a chat: the customer replies with a number or, for free text, a message. */
  function chatPrompt(q) {
    if (q.type === 'rating') return `${q.text} Reply with a number from 1 (very dissatisfied) to 5 (very satisfied).`;
    if (q.type === 'nps') return `${q.text} Reply with a number from 0 (not at all likely) to 10 (extremely likely).`;
    if (q.type === 'ces') return `${q.text} Reply with a number from 1 (very difficult) to 7 (very easy).`;
    if (q.type === 'yesno') return `${q.text} Reply 1 for yes or 0 for no.`;
    if (q.type === 'choice') return `${q.text} ${q.options.map((o, i) => `${i + 1} = ${o}`).join(', ')}. Reply with the number.`;
    return `${q.text} Type your answer, or reply with a dash (-) to skip.`;
  }
  const promptFor = (q, channel) => (channel === 'voice' ? voicePrompt(q) : chatPrompt(q));

  /** Scores for a completed response: csat (1-5 avg of rating questions), nps (0-10, first), ces (1-7, first), five (1-5 overall). */
  function scoreResponse(survey, answers) {
    const out = { csat: null, nps: null, ces: null, five: null, low: false, agentFive: null };
    const fives = [], agentFives = [], ratings = [];
    for (const q of survey.questions) {
      const v = answers[q.id];
      if (v === undefined || v === '' || q.type === 'text' || q.type === 'choice') continue;
      const f = toFive(q.type, v);
      if (f == null) continue;
      fives.push(f);
      if (q.agentAttributable) agentFives.push(f);
      if (q.type === 'rating') ratings.push(Number(v));
      if (q.type === 'nps' && out.nps === null) out.nps = Number(v);
      if (q.type === 'ces' && out.ces === null) out.ces = Number(v);
    }
    if (ratings.length) out.csat = round1(ratings.reduce((a, b) => a + b, 0) / ratings.length);
    if (fives.length) out.five = round1(fives.reduce((a, b) => a + b, 0) / fives.length);
    if (agentFives.length) out.agentFive = round1(agentFives.reduce((a, b) => a + b, 0) / agentFives.length);
    const l = survey.lowScore || { enabled: false };
    if (l.enabled) {
      if (l.question === 'any') out.low = fives.some((f) => f <= l.threshold);
      else { const q = survey.questions.find((x) => x.id === l.question); const f = q ? toFive(q.type, answers[q.id]) : null; out.low = f != null && f <= l.threshold; }
    }
    return out;
  }

  /** NPS from a list of 0-10 answers: % promoters (9-10) minus % detractors (0-6), rounded. */
  function npsOf(list) {
    const v = list.filter((n) => Number.isFinite(n));
    if (!v.length) return null;
    const p = v.filter((n) => n >= 9).length, d = v.filter((n) => n <= 6).length;
    return Math.round(((p - d) / v.length) * 100);
  }
  /** CSAT % = share of ratings at 4 or 5 (top-two-box), plus the mean. */
  function csatOf(list) {
    const v = list.filter((n) => Number.isFinite(n));
    if (!v.length) return { pct: null, mean: null, n: 0 };
    return { pct: Math.round((v.filter((n) => n >= 4).length / v.length) * 100), mean: round1(v.reduce((a, b) => a + b, 0) / v.length), n: v.length };
  }

  /**
   * Aggregate completed responses: overall, by agent, by queue, by driver (question), by day. Each group carries
   * n, csat, nps, ces, five, low count. `rows` are stored responses with scores already computed. Pure.
   */
  function aggregate(rows, surveys) {
    const byId = Object.fromEntries((surveys || []).map((s) => [s.id, s]));
    const group = () => ({ n: 0, offered: 0, started: 0, ratings: [], nps: [], ces: [], fives: [], low: 0 });
    const overall = group(), agents = {}, queues = {}, days = {}, drivers = {}, channels = {};
    const add = (g, r) => {
      g.offered++;
      if (r.status === 'started' || r.status === 'completed') g.started++;
      if (r.status !== 'completed') return;
      g.n++;
      const sc = r.scores || {};
      if (sc.csat != null) g.ratings.push(sc.csat);
      if (sc.nps != null) g.nps.push(sc.nps);
      if (sc.ces != null) g.ces.push(sc.ces);
      if (sc.five != null) g.fives.push(sc.five);
      if (sc.low) g.low++;
    };
    for (const r of rows) {
      add(overall, r);
      const a = r.agentArn || 'unassigned', q = r.queue || 'unassigned', d = (r.completedAt || r.startedAt || '').slice(0, 10), c = r.channel || 'voice';
      add(agents[a] = agents[a] || Object.assign(group(), { id: a, name: r.agentName || a.split('/').pop() }), r);
      add(queues[q] = queues[q] || Object.assign(group(), { id: q }), r);
      add(days[d] = days[d] || Object.assign(group(), { id: d }), r);
      add(channels[c] = channels[c] || Object.assign(group(), { id: c }), r);
      if (r.status === 'completed') {
        const s = byId[r.surveyId];
        for (const qd of (s ? s.questions : [])) {
          const v = r.answers && r.answers[qd.id];
          if (v === undefined || v === '' || qd.type === 'text') continue;
          const key = qd.driver || qd.text;
          const g = drivers[key] = drivers[key] || Object.assign(group(), { id: key, type: qd.type, choices: {} });
          g.n++;
          if (qd.type === 'choice') g.choices[qd.options[v - 1] || v] = (g.choices[qd.options[v - 1] || v] || 0) + 1;
          else { const f = toFive(qd.type, v); if (f != null) g.fives.push(f); if (qd.type === 'rating') g.ratings.push(Number(v)); if (qd.type === 'nps') g.nps.push(Number(v)); if (qd.type === 'ces') g.ces.push(Number(v)); }
        }
      }
    }
    const fin = (g) => { const c = csatOf(g.ratings); return Object.assign({}, g, { csat: c.mean, csatPct: c.pct, nps: npsOf(g.nps), ces: g.ces.length ? round1(g.ces.reduce((a, b) => a + b, 0) / g.ces.length) : null, five: g.fives.length ? round1(g.fives.reduce((a, b) => a + b, 0) / g.fives.length) : null, completion: g.offered ? Math.round((g.n / g.offered) * 100) : null, ratings: undefined, fives: undefined, ces_: undefined }); };
    const list = (o) => Object.values(o).map(fin).sort((x, y) => (y.n - x.n) || String(x.id).localeCompare(String(y.id)));
    return { overall: fin(overall), agents: list(agents), queues: list(queues), drivers: list(drivers), channels: list(channels), days: Object.values(days).map(fin).sort((x, y) => x.id.localeCompare(y.id)) };
  }

  /** CSV of responses, one row per response with a column per question. Quotes and commas escaped. */
  function toCsv(rows, surveys) {
    const byId = Object.fromEntries((surveys || []).map((s) => [s.id, s]));
    const qcols = [];
    for (const s of surveys || []) for (const q of s.questions) if (!qcols.some((c) => c.id === q.id)) qcols.push({ id: q.id, label: `${s.name}: ${q.text}` });
    const head = ['contactId', 'survey', 'channel', 'queue', 'agent', 'agentArn', 'status', 'startedAt', 'completedAt', 'csat', 'nps', 'ces', 'five', 'low', ...qcols.map((c) => c.label)];
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.map(esc).join(',')];
    for (const r of rows) {
      const s = byId[r.surveyId], sc = r.scores || {};
      lines.push([r.contactId, s ? s.name : r.surveyId, r.channel, r.queue, r.agentName, r.agentArn, r.status, r.startedAt, r.completedAt, sc.csat, sc.nps, sc.ces, sc.five, sc.low ? 'yes' : '', ...qcols.map((c) => (r.answers || {})[c.id])].map(esc).join(','));
    }
    return lines.join('\n') + '\n';
  }

  /** A starter survey a new stack ships with. */
  const DEFAULT_SURVEY = { name: 'Post-contact survey', questions: [
    { id: 'csat', type: 'rating', text: 'How satisfied were you with the service you received today?', driver: 'Overall satisfaction', agentAttributable: true },
    { id: 'resolved', type: 'yesno', text: 'Was your issue resolved?', driver: 'First contact resolution', agentAttributable: false },
    { id: 'effort', type: 'ces', text: 'How easy was it to get the help you needed?', driver: 'Effort', agentAttributable: false },
    { id: 'nps', type: 'nps', text: 'How likely are you to recommend us to a friend or colleague?', driver: 'Recommend', agentAttributable: false },
    { id: 'why', type: 'text', text: 'What could we have done better?', skipUnless: { question: 'csat', atMost: 3 } } ],
    lowScore: { enabled: true, threshold: 2, question: 'any' } };

  return { TYPES, CHANNELS, MAX_QUESTIONS, normalizeSurvey, pickSurvey, sampled, nextQuestion, parseAnswer, voicePrompt, voiceDigits, chatPrompt, promptFor, scoreResponse, npsOf, csatOf, toFive, aggregate, toCsv, DEFAULT_SURVEY };
});
