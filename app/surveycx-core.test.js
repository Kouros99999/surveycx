const assert = require('node:assert/strict');
const { test } = require('node:test');
const S = require('./surveycx-core.js');

const survey = () => S.normalizeSurvey(Object.assign({ id: 'default', target: { queues: ['Billing'], channels: ['voice', 'chat', 'sms', 'email', 'web'] } }, S.DEFAULT_SURVEY));

test('normalizeSurvey fills defaults, keeps ids, marks ratings agent-attributable and validates skip rules', () => {
  const s = survey();
  assert.equal(s.status, 'active'); assert.equal(s.questions.length, 5);
  assert.equal(s.questions[0].agentAttributable, true); assert.equal(s.questions[3].agentAttributable, false); assert.equal(s.questions[4].agentAttributable, undefined);
  assert.deepEqual(s.questions[4].skipUnless, { question: 'csat', atMost: 3 });
  assert.throws(() => S.normalizeSurvey({ name: 'x', questions: [] }), /at least one question/);
  assert.throws(() => S.normalizeSurvey({ name: 'x', questions: [{ type: 'choice', text: 'Which?', options: ['a'] }] }), /2 to 9 options/);
  assert.throws(() => S.normalizeSurvey({ name: 'x', questions: [{ type: 'text', text: 'Why?', skipUnless: { question: 'nope' } }] }), /earlier question/);
  assert.throws(() => S.normalizeSurvey({ name: 'x', questions: Array.from({ length: 11 }, (_, i) => ({ type: 'rating', text: 'q' + i })) }), /at most 10/);
});

test('pickSurvey prefers attribute, then queue, then the untargeted default; channel must be allowed', () => {
  const def = S.normalizeSurvey({ id: 'd', name: 'Default', questions: [{ type: 'rating', text: 'a' }] });
  const q = S.normalizeSurvey({ id: 'q', name: 'Billing', target: { queues: ['Billing'] }, questions: [{ type: 'rating', text: 'a' }] });
  const a = S.normalizeSurvey({ id: 'a', name: 'VIP', target: { attribute: { name: 'tier', value: 'gold' }, channels: ['voice'] }, questions: [{ type: 'rating', text: 'a' }] });
  const all = [def, q, a];
  assert.equal(S.pickSurvey(all, { queue: 'Billing', channel: 'voice' }).id, 'q');
  assert.equal(S.pickSurvey(all, { queue: 'Billing', channel: 'voice', attributes: { tier: 'gold' } }).id, 'a');
  assert.equal(S.pickSurvey(all, { queue: 'Billing', channel: 'chat', attributes: { tier: 'gold' } }).id, 'q', 'VIP survey is voice only');
  assert.equal(S.pickSurvey(all, { queue: 'Sales', channel: 'chat' }).id, 'd');
  assert.equal(S.pickSurvey([Object.assign({}, q, { status: 'paused' })], { queue: 'Billing', channel: 'voice' }), null);
});

test('sampled is deterministic per contact and respects the percentage roughly', () => {
  assert.equal(S.sampled('c1', 100), true);
  const hits = Array.from({ length: 1000 }, (_, i) => S.sampled('contact-' + i, 50)).filter(Boolean).length;
  assert.ok(hits > 400 && hits < 600, 'about half: ' + hits);
  assert.equal(S.sampled('abc', 30), S.sampled('abc', 30));
});

test('nextQuestion walks the survey, skips free text on voice and honours the skip rule', () => {
  const s = survey();
  assert.equal(S.nextQuestion(s, {}, 'voice').id, 'csat');
  assert.equal(S.nextQuestion(s, { csat: 5, resolved: 1, effort: 7, nps: 10 }, 'voice'), null, 'no text on voice');
  assert.equal(S.nextQuestion(s, { csat: 5, resolved: 1, effort: 7, nps: 10 }, 'web'), null, 'score was fine, why is skipped');
  assert.equal(S.nextQuestion(s, { csat: 2, resolved: 0, effort: 2, nps: 3 }, 'web').id, 'why');
});

test('parseAnswer enforces each scale; voice prompts and digit counts', () => {
  const s = survey();
  assert.equal(S.parseAnswer(s.questions[0], '4'), 4);
  assert.throws(() => S.parseAnswer(s.questions[0], '6'), /1 to 5/);
  assert.equal(S.parseAnswer(s.questions[3], '10'), 10);
  assert.throws(() => S.parseAnswer(s.questions[3], '11'), /0 to 10/);
  assert.equal(S.parseAnswer(s.questions[1], 0), 0);
  assert.equal(S.parseAnswer(s.questions[4], ' too slow '), 'too slow');
  assert.throws(() => S.parseAnswer(s.questions[0], ''), /required/);
  assert.match(S.voicePrompt(s.questions[0]), /Press 1 .* 5/); assert.equal(S.voiceDigits(s.questions[3]), 2); assert.equal(S.voiceDigits(s.questions[0]), 1);
  const ch = S.normalizeSurvey({ name: 'c', questions: [{ type: 'choice', text: 'Reason?', options: ['Billing', 'Outage', 'Other'] }] }).questions[0];
  assert.match(S.voicePrompt(ch), /Press 3 for Other/); assert.equal(S.parseAnswer(ch, 3), 3); assert.throws(() => S.parseAnswer(ch, 4));
});

test('scoreResponse computes csat, nps, ces, the 1-5 overall, the agent-only score and the low flag', () => {
  const s = survey();
  const good = S.scoreResponse(s, { csat: 5, resolved: 1, effort: 7, nps: 10 });
  assert.equal(good.csat, 5); assert.equal(good.nps, 10); assert.equal(good.ces, 7); assert.equal(good.five, 5); assert.equal(good.agentFive, 5); assert.equal(good.low, false);
  const bad = S.scoreResponse(s, { csat: 1, resolved: 0, effort: 1, nps: 0, why: 'rude' });
  assert.equal(bad.five, 1); assert.equal(bad.low, true);
  const mixed = S.scoreResponse(s, { csat: 4, resolved: 0, effort: 4, nps: 5 });
  assert.equal(mixed.agentFive, 4); assert.equal(mixed.low, true, 'resolved = no is a 1 on the five scale');
  const only = S.normalizeSurvey({ name: 'x', questions: [{ type: 'rating', text: 'a' }], lowScore: { threshold: 2, question: 'a-1' } });
  assert.equal(S.scoreResponse(only, { 'a-1': 2 }).low, true); assert.equal(S.scoreResponse(only, { 'a-1': 3 }).low, false);
});

test('npsOf, csatOf, toFive', () => {
  assert.equal(S.npsOf([10, 9, 7, 3]), 25); assert.equal(S.npsOf([]), null);
  assert.deepEqual(S.csatOf([5, 4, 2, 1]), { pct: 50, mean: 3, n: 4 });
  assert.equal(S.toFive('nps', 10), 5); assert.equal(S.toFive('nps', 0), 1); assert.equal(S.toFive('ces', 4), 3); assert.equal(S.toFive('yesno', 0), 1); assert.equal(S.toFive('text', 'x'), null);
});

test('aggregate groups by agent, queue, driver, day and channel with a completion funnel; toCsv has one column per question', () => {
  const s = survey();
  const row = (id, agent, queue, answers, status, at, channel) => { const scores = status === 'completed' ? S.scoreResponse(s, answers) : {}; return { contactId: id, surveyId: s.id, agentArn: agent, agentName: agent, queue, channel: channel || 'voice', answers, status: status || 'completed', startedAt: at, completedAt: status === 'completed' || !status ? at : undefined, scores }; };
  const rows = [row('1', 'ann', 'Billing', { csat: 5, resolved: 1, effort: 7, nps: 10 }, 'completed', '2026-10-01T10:00:00Z'), row('2', 'ann', 'Billing', { csat: 1, resolved: 0, effort: 1, nps: 0 }, 'completed', '2026-10-02T10:00:00Z', 'chat'),
    row('3', 'bob', 'Sales', { csat: 4, resolved: 1, effort: 6, nps: 8 }, 'completed', '2026-10-02T11:00:00Z'), row('4', 'bob', 'Sales', {}, 'offered', '2026-10-02T12:00:00Z'), row('5', 'bob', 'Sales', { csat: 3 }, 'started', '2026-10-02T12:00:00Z')];
  const a = S.aggregate(rows, [s]);
  assert.equal(a.overall.n, 3); assert.equal(a.overall.offered, 5); assert.equal(a.overall.started, 4); assert.equal(a.overall.completion, 60);
  assert.equal(a.overall.csatPct, 67); assert.equal(a.overall.nps, 0); assert.equal(a.overall.low, 1);
  const ann = a.agents.find((x) => x.id === 'ann'); assert.equal(ann.n, 2); assert.equal(ann.csat, 3);
  assert.equal(a.queues.find((x) => x.id === 'Sales').n, 1);
  assert.equal(a.days.length, 2); assert.equal(a.days[1].n, 2);
  assert.equal(a.channels.find((x) => x.id === 'chat').n, 1);
  const fcr = a.drivers.find((d) => d.id === 'First contact resolution'); assert.equal(fcr.n, 3); assert.equal(fcr.five, 3.7);
  assert.equal(a.drivers.find((d) => d.id === 'Recommend').nps, 0);
  const csv = S.toCsv(rows, [s]);
  assert.match(csv.split('\n')[0], /contactId,survey,.*Post-contact survey: How satisfied/); assert.equal(csv.trim().split('\n').length, 6);
});
