/*
 * Daily theme extraction. Runs hourly and acts once per local day: for every active survey, and for all surveys
 * together, it takes the free-text answers of the trailing THEME_DAYS days, redacts them, asks the model for themes,
 * and stores the result as THEMES / <surveyId>#<day>. The report shows the newest themes inside its date range.
 * Disabled unless the stack has VerbatimAnalysis=enabled (THEMES_MODEL_ID set). A failed call keeps yesterday's themes.
 */
'use strict';
const clock = require('./clock.js');
const verbatim = require('./verbatim.js');

const MODEL_ID = process.env.THEMES_MODEL_ID || '';
const THEME_DAYS = Math.max(7, +(process.env.THEME_DAYS || 30));

/** Pure: the free-text answers of a set of responses, with the survey's language. */
function commentsOf(rows, surveys) {
  const byId = Object.fromEntries(surveys.map((s) => [s.id, s]));
  const out = [];
  for (const r of rows) {
    if (r.status !== 'completed') continue;
    const s = byId[r.surveyId]; if (!s) continue;
    for (const q of s.questions) if (q.type === 'text' && typeof (r.answers || {})[q.id] === 'string' && r.answers[q.id].trim()) out.push({ text: r.answers[q.id], lang: s.language, surveyId: s.id });
  }
  return out;
}

async function run(store, clients, nowMs, modelId) {
  const today = clock.dayKey(nowMs), day = clock.addDays(today, -1);
  if (!modelId) return { skipped: 'no model configured' };
  const mark = await store.getMeter('THEMES#' + day);
  if (mark) return { skipped: 'already done', day };
  const surveys = await store.listSurveys();
  const rows = await store.responsesBetween(clock.addDays(day, 1 - THEME_DAYS), day);
  const all = commentsOf(rows, surveys);
  const groups = [['*', all], ...surveys.filter((s) => s.status === 'active').map((s) => [s.id, all.filter((c) => c.surveyId === s.id)])];
  let written = 0;
  for (const [id, list] of groups) {
    if (list.length < 3) continue;
    const themes = await verbatim.extractThemes(clients, list.map((c) => c.text), list[0].lang, modelId);
    if (!themes.length) continue;
    await store.putThemes(id, day, { themes, comments: list.length, from: clock.addDays(day, 1 - THEME_DAYS), to: day, model: modelId, at: new Date(nowMs).toISOString() });
    written++;
  }
  await store.putMeter('THEMES#' + day, { at: new Date(nowMs).toISOString(), groups: written, comments: all.length });
  return { day, groups: written, comments: all.length };
}

exports.handler = async (event, context, deps) => {
  deps = deps || {};
  const s = deps.store || require('./store.js');
  const r = await run(s, deps.clients || verbatim.safeClients(), deps.now ? deps.now() : Date.now(), deps.modelId !== undefined ? deps.modelId : MODEL_ID);
  console.log(JSON.stringify(r));
  return r;
};
exports.run = run; exports.commentsOf = commentsOf;
