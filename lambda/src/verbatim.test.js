const assert = require('node:assert/strict');
const { test } = require('node:test');
const V = require('./verbatim.js');
const themes = require('./themes.js');
const mem = require('./memstore.js');
const S = require('./surveycx-core.js');
const responses = require('./responses.js');
const contacts = require('./contacts.js');

test('redact masks emails, phones, cards, ids, account numbers, long numbers, names and links, and leaves the rest', () => {
  const t = V.redact('Call me at (555) 010-0100 or ann@example.com, my name is Ann Lee, account # AC-123456, card 4111 1111 1111 1111, order 98765432, see https://x.test/a. The agent was rude.');
  assert.ok(!/555|example\.com|Ann Lee|AC-123456|4111|98765432|x\.test/.test(t), t);
  assert.match(t, /\[phone\]/); assert.match(t, /\[email\]/); assert.match(t, /my name is \[name\]/); assert.match(t, /\[card\]/); assert.match(t, /\[link\]/); assert.match(t, /The agent was rude\./);
  assert.equal(V.redact('Waited 40 minutes'), 'Waited 40 minutes');
  assert.equal(V.langOf('fr-CA'), 'fr'); assert.equal(V.langOf('xx'), 'en'); assert.equal(V.langOf('zh-TW'), 'zh-TW');
});

test('sentimentOf sends redacted text to Comprehend and never throws', async () => {
  const sent = [];
  const clients = { comprehend: { send: async (c) => { sent.push(c.input); return { Sentiment: 'NEGATIVE', SentimentScore: { Positive: 0.01, Negative: 0.9123, Neutral: 0.05, Mixed: 0.02 } }; } }, DetectSentimentCommand: function (i) { this.input = i; } };
  const r = await V.sentimentOf(clients, 'Rude agent, call me on 555-010-0100', 'en-US');
  assert.deepEqual(r, { label: 'negative', positive: 0.01, negative: 0.91, neutral: 0.05, mixed: 0.02 });
  assert.equal(sent[0].Text, 'Rude agent, call me on [phone]'); assert.equal(sent[0].LanguageCode, 'en');
  assert.equal(await V.sentimentOf({ comprehend: { send: async () => { throw new Error('throttled'); } }, DetectSentimentCommand: function () {} }, 'bad', 'en'), null);
  assert.equal(await V.sentimentOf(clients, 'ok', 'en'), null, 'too short');
});

test('themePrompt numbers the comments; parseThemes tolerates fences and maps examples back', () => {
  const texts = ['Waited 40 minutes', 'Still not resolved', 'Great service'];
  assert.match(V.themePrompt(texts, 'en-US', 5), /1\. Waited 40 minutes\n2\. Still not resolved\n3\. Great service/);
  const parsed = V.parseThemes('Here you go:\n```json\n{"themes":[{"name":"Wait time","sentiment":"negative","count":1,"examples":[1]},{"name":"Resolution","sentiment":"NEGATIVE","count":1,"examples":[2,9]},{"name":"","count":3}]}\n```', texts, 8);
  assert.deepEqual(parsed, [{ name: 'Wait time', sentiment: 'negative', count: 1, examples: ['Waited 40 minutes'] }, { name: 'Resolution', sentiment: 'negative', count: 1, examples: ['Still not resolved'] }]);
  assert.deepEqual(V.parseThemes('no json here', texts), []);
});

test('extractThemes calls Bedrock Converse with redacted comments; themes job runs once per day per survey and overall', async () => {
  const calls = [];
  const clients = { bedrock: { send: async (c) => { calls.push(c.input); const n = (c.input.messages[0].content[0].text.match(/^\d+\. /gm) || []).length; return { output: { message: { content: [{ text: JSON.stringify({ themes: [{ name: 'Wait time', sentiment: 'negative', count: n, examples: [1] }] }) }] } } }; } }, ConverseCommand: function (i) { this.input = i; } };
  assert.deepEqual(await V.extractThemes(clients, ['a', 'b'], 'en', 'm'), [], 'fewer than three comments');
  const s = mem.make();
  const survey = S.normalizeSurvey({ id: 'default', name: 'D', questions: [{ id: 'csat', type: 'rating', text: 'x' }, { id: 'why', type: 'text', text: 'why' }] }); await s.putSurvey(survey);
  for (let i = 0; i < 5; i++) await s.putResponse({ contactId: 'c' + i, surveyId: 'default', status: 'completed', startedAt: '2026-10-10T10:00:00Z', completedAt: '2026-10-10T10:01:00Z', answers: { csat: 2, why: `Waited ages, call 555-010-010${i}` }, scores: {} });
  await s.putResponse({ contactId: 'skip', surveyId: 'default', status: 'started', startedAt: '2026-10-10T10:00:00Z', answers: { why: 'incomplete' } });
  const r = await themes.run(s, clients, Date.parse('2026-10-11T03:35:00Z'), 'model-x');
  assert.deepEqual(r, { day: '2026-10-10', groups: 2, comments: 5 });
  assert.equal(calls.length, 2); assert.equal(calls[0].modelId, 'model-x'); assert.ok(!calls[0].messages[0].content[0].text.includes('555-010'), 'redacted');
  const t = await s.getThemes('*', '2026-10-11'); assert.equal(t.themes[0].name, 'Wait time'); assert.equal(t.themes[0].count, 5); assert.equal(t.comments, 5);
  assert.equal((await s.getThemes('default', '2026-10-11')).comments, 5); assert.equal(await s.getThemes('default', '2026-10-09'), null);
  assert.equal((await themes.run(s, clients, Date.parse('2026-10-11T04:35:00Z'), 'model-x')).skipped, 'already done');
  assert.equal((await themes.run(s, clients, Date.parse('2026-10-12T04:35:00Z'), '')).skipped, 'no model configured');
});

test('completing a response scores sentiment when analysis is enabled and puts it in the report, webhook and CSV', async () => {
  process.env.VERBATIM_ANALYSIS = 'enabled';
  try {
    const s = mem.make();
    const survey = S.normalizeSurvey({ id: 'default', name: 'D', questions: [{ id: 'csat', type: 'rating', text: 'x' }, { id: 'why', type: 'text', text: 'why' }] }); await s.putSurvey(survey);
    await s.putSettings({ webhooks: [{ url: 'https://h.test', secret: '', events: ['completed'] }] });
    const posts = [];
    const clients = { comprehend: { send: async () => ({ Sentiment: 'NEGATIVE', SentimentScore: { Negative: 0.9 } }) }, DetectSentimentCommand: function (i) { this.input = i; } };
    const row = await responses.offer(s, contacts.normalizeContact({ contactId: 'c1', channel: 'voice', agent: 'a' }), survey, 'web', '2026-10-11T10:00:00Z');
    await responses.answer(s, row, survey, 'csat', 1, '2026-10-11T10:01:00Z'); await responses.answer(s, row, survey, 'why', 'Rude and slow', '2026-10-11T10:01:00Z');
    await responses.complete(s, row, survey, '2026-10-11T10:02:00Z', { clients, post: async (u, b) => posts.push(b) });
    assert.equal((await s.getResponse('c1')).sentiment.label, 'negative'); assert.equal(posts[0].sentiment.label, 'negative');
    const agg = S.aggregate(await s.responsesBetween('2026-10-11', '2026-10-11'), [survey]);
    assert.equal(agg.overall.comments, 1); assert.equal(agg.overall.negative, 1); assert.equal(agg.agents[0].negative, 1);
    assert.match(S.toCsv(await s.responsesBetween('2026-10-11', '2026-10-11'), [survey]), /,negative,/);
    // switched off in settings: no call
    await s.putSettings({ analysis: { sentiment: false } });
    const row2 = await responses.offer(s, contacts.normalizeContact({ contactId: 'c2', channel: 'voice', agent: 'a' }), survey, 'web', '2026-10-11T10:00:00Z');
    await responses.answer(s, row2, survey, 'why', 'meh', '2026-10-11T10:01:00Z'); await responses.complete(s, row2, survey, '2026-10-11T10:02:00Z', { clients: { comprehend: { send: async () => { throw new Error('should not be called'); } }, DetectSentimentCommand: function () {} } });
    assert.equal((await s.getResponse('c2')).sentiment, undefined);
  } finally { delete process.env.VERBATIM_ANALYSIS; }
});
