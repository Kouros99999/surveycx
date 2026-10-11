/*
 * The Lambda Amazon Connect invokes from the SurveyCX flow module, in the disconnect flow of a voice call or a chat.
 *
 * Connect passes the contact (queue, channel, attributes) and a parameter `action`:
 *   start               pick the survey for this contact; answer with the intro and the first prompt
 *   answer digits=<x>   record the customer's input for the current question; answer with the next prompt or the outro
 *
 * Connect accepts only a flat map of strings back, read in the flow as $.External.<name>:
 *   eligible   'true' | 'false'     whether a survey applies (sampling, targeting, channel, already surveyed)
 *   intro      the intro text (start only)
 *   prompt     what to say or type next
 *   digits     max DTMF digits for the next question ('1' or '2')
 *   question   id of the question the prompt asks
 *   retry      'true' when the last input was invalid and the same question is asked again
 *   done       'true' when the survey is complete; outro holds the closing text
 *
 * The agent is not known in the disconnect flow; the contact record that arrives a little later (ingest.js) fills it in.
 */
'use strict';
const S = require('./surveycx-core.js');
const storeMod = require('./store.js');
const contacts = require('./contacts.js');
const responses = require('./responses.js');

/** Pure: read what Connect sent into a canonical contact plus the action. */
function parseEvent(event) {
  const d = (event && event.Details) || {};
  const cd = d.ContactData || {}, p = d.Parameters || {};
  const ch = String(cd.Channel || 'VOICE').toLowerCase();
  const ep = cd.CustomerEndpoint || {};
  const contact = { contactId: cd.InitialContactId || cd.ContactId, channel: ch === 'chat' ? 'chat' : 'voice', queue: cd.Queue && cd.Queue.Name, attributes: cd.Attributes || {}, phone: ep.Type === 'TELEPHONE_NUMBER' ? ep.Address : undefined, platform: 'connect' };
  return { action: String(p.action || 'start').toLowerCase(), digits: p.digits == null ? '' : String(p.digits).trim(), contact };
}

function makeHandler(deps) {
  const s = deps.store || storeMod, now = deps.now || (() => new Date());
  return async (event) => {
    const { action, digits, contact } = parseEvent(event);
    if (!contact.contactId) return { eligible: 'false', reason: 'no contact id' };
    const nowIso = now().toISOString();
    if (action === 'start') {
      const surveys = await s.listSurveys();
      let c;
      try { c = contacts.normalizeContact(contact, nowIso); } catch { c = Object.assign({}, contact, { phone: undefined }); }
      const survey = S.pickSurvey(surveys, c);
      if (!survey) return { eligible: 'false', reason: 'no survey for this contact' };
      if (!S.sampled(c.contactId, survey.target.sample)) return { eligible: 'false', reason: 'not sampled' };
      const existing = await s.getResponse(c.contactId);
      if (existing && existing.status === 'completed') return { eligible: 'false', reason: 'already surveyed' };
      const row = existing || await responses.offer(s, c, survey, c.channel, nowIso);
      const q = S.nextQuestion(survey, row.answers, c.channel);
      if (!q) { await responses.complete(s, row, survey, nowIso, deps); return { eligible: 'true', done: 'true', intro: survey.intro, outro: survey.outro }; }
      return { eligible: 'true', done: 'false', intro: survey.intro, prompt: S.promptFor(q, c.channel), digits: String(S.voiceDigits(q)), question: q.id, survey: survey.id };
    }
    if (action === 'answer') {
      const row = await s.getResponse(contact.contactId);
      if (!row) return { eligible: 'false', reason: 'survey was not started' };
      const survey = await s.getSurvey(row.surveyId);
      if (!survey) return { eligible: 'false', reason: 'survey was removed' };
      const current = S.nextQuestion(survey, row.answers, row.channel);
      if (!current) { await responses.complete(s, row, survey, nowIso, deps); return { eligible: 'true', done: 'true', outro: survey.outro }; }
      let next;
      try {
        // A dash skips an optional free-text question in chat; anything else is parsed on the question's scale.
        const raw = current.type === 'text' && digits === '-' ? '' : digits;
        ({ next } = await responses.answer(s, row, survey, current.id, raw, nowIso));
      } catch (e) {
        return { eligible: 'true', done: 'false', retry: 'true', prompt: (row.channel === 'voice' ? "Sorry, that wasn't a valid answer. " : 'Sorry, that was not a valid answer. ') + S.promptFor(current, row.channel), digits: String(S.voiceDigits(current)), question: current.id };
      }
      if (!next) { await responses.complete(s, row, survey, nowIso, deps); return { eligible: 'true', done: 'true', outro: survey.outro }; }
      return { eligible: 'true', done: 'false', prompt: S.promptFor(next, row.channel), digits: String(S.voiceDigits(next)), question: next.id };
    }
    return { eligible: 'false', reason: 'unknown action' };
  };
}

exports.parseEvent = parseEvent;
exports.makeHandler = makeHandler;
exports.handler = makeHandler({});
