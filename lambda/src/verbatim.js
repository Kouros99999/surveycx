/*
 * Verbatim analysis: what customers wrote, made useful without leaking who they are.
 *
 *   redact(text)                     pure: masks emails, phone numbers, card and account numbers, long digit runs, and
 *                                    "my name is X" style self-identification before text goes to any AI service
 *   sentimentOf(clients, text, lang) Amazon Comprehend DetectSentiment on the redacted text -> { label, scores }
 *   themePrompt / parseThemes        pure: the Bedrock prompt for a batch of comments and the parser for its answer
 *   extractThemes(clients, texts, lang, modelId)   Bedrock Converse -> [{ name, count, sentiment, examples }]
 *
 * The stored answer is never changed; only the copy sent out is redacted. Everything runs inside the customer's account.
 */
'use strict';

const RULES = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id]'],
  [/\b(?:account|acct|policy|order|member|customer|ref(?:erence)?|ticket|case|invoice)\s*(?:#|no\.?|number)?\s*[:#]?\s*[A-Z0-9-]{5,}\b/gi, '$& '.replace(/.*/, (m) => '[account]')],
  [/\b\d{6,}\b/g, '[number]'],
  [/\b(my name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, '$1 [name]'],
  [/https?:\/\/\S+/gi, '[link]'],
];
function redact(text) {
  let t = String(text == null ? '' : text);
  for (const [re, rep] of RULES) t = t.replace(re, typeof rep === 'function' ? rep : rep);
  return t;
}

const COMPREHEND_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'hi', 'ja', 'ko', 'zh', 'zh-TW'];
const langOf = (tag) => { const l = String(tag || 'en').toLowerCase(); if (l.startsWith('zh-tw') || l.startsWith('zh-hant')) return 'zh-TW'; const two = l.slice(0, 2); return COMPREHEND_LANGS.includes(two) ? two : 'en'; };

/** Sentiment of one comment. Never throws: on any failure the response simply has no sentiment. */
async function sentimentOf(clients, text, langTag) {
  const t = redact(text).trim();
  if (!clients || !clients.comprehend || t.length < 3) return null;
  try {
    const r = await clients.comprehend.send(new clients.DetectSentimentCommand({ Text: t.slice(0, 4500), LanguageCode: langOf(langTag) }));
    const s = r.SentimentScore || {};
    return { label: String(r.Sentiment || 'NEUTRAL').toLowerCase(), positive: round(s.Positive), negative: round(s.Negative), neutral: round(s.Neutral), mixed: round(s.Mixed) };
  } catch (e) { console.warn(JSON.stringify({ sentiment: 'failed', error: e.name, message: String(e.message || '').slice(0, 200) })); return null; }
}
const round = (n) => Math.round((n || 0) * 100) / 100;

/** Pure: the instruction for the model. Comments arrive redacted and numbered so examples can be quoted back by number. */
function themePrompt(texts, langTag, maxThemes) {
  const list = texts.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').trim().slice(0, 400)}`).join('\n');
  return `You analyse customer feedback for a contact centre. Below are ${texts.length} customer comments from post-contact surveys, in language "${langOf(langTag)}". Group them into at most ${maxThemes} themes a supervisor can act on (for example "Long wait time", "Issue not resolved", "Agent was helpful"). Ignore comments that are empty, nonsense or only a thank-you.

Answer with JSON only, no prose, in this exact shape:
{"themes":[{"name":"short theme name","sentiment":"positive|negative|mixed","count":<number of comments in this theme>,"examples":[<up to 3 comment numbers>]}]}

Order themes by count, largest first. A comment may belong to one theme only. Use the customers' language for theme names.

Comments:
${list}`;
}

/** Pure: parse the model's JSON, tolerate fences and stray text, map example numbers back to comments. */
function parseThemes(answer, texts, maxThemes) {
  const m = String(answer || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  let j; try { j = JSON.parse(m[0]); } catch { return []; }
  const out = [];
  for (const t of Array.isArray(j.themes) ? j.themes : []) {
    const name = String(t.name || '').trim().slice(0, 80); if (!name) continue;
    const count = Math.max(0, Math.min(texts.length, Math.round(Number(t.count) || 0)));
    const examples = (Array.isArray(t.examples) ? t.examples : []).map((n) => texts[Number(n) - 1]).filter(Boolean).slice(0, 3).map((x) => x.slice(0, 200));
    out.push({ name, sentiment: ['positive', 'negative', 'mixed'].includes(String(t.sentiment).toLowerCase()) ? String(t.sentiment).toLowerCase() : 'mixed', count, examples });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, maxThemes || 8);
}

/** Themes for a batch of comments through Bedrock Converse. Returns [] on failure; the caller keeps yesterday's themes. */
async function extractThemes(clients, texts, langTag, modelId, maxThemes) {
  const clean = texts.map(redact).filter((t) => t.trim().length >= 3).slice(0, 300);
  if (!clients || !clients.bedrock || clean.length < 3) return [];
  try {
    const r = await clients.bedrock.send(new clients.ConverseCommand({ modelId, messages: [{ role: 'user', content: [{ text: themePrompt(clean, langTag, maxThemes || 8) }] }], inferenceConfig: { maxTokens: 1500, temperature: 0 } }));
    const text = (((r.output || {}).message || {}).content || []).map((c) => c.text || '').join('');
    return parseThemes(text, clean, maxThemes || 8);
  } catch (e) { console.warn(JSON.stringify({ themes: 'failed', modelId, error: e.name, message: String(e.message || '').slice(0, 300), status: e.$metadata && e.$metadata.httpStatusCode })); return []; }
}

let clients;
function realClients() {
  if (clients) return clients;
  const c = require('@aws-sdk/client-comprehend'), b = require('@aws-sdk/client-bedrock-runtime');
  clients = { comprehend: new c.ComprehendClient({}), DetectSentimentCommand: c.DetectSentimentCommand, bedrock: new b.BedrockRuntimeClient({}), ConverseCommand: b.ConverseCommand };
  return clients;
}
function safeClients() { try { return realClients(); } catch { return null; } }

module.exports = { redact, langOf, sentimentOf, themePrompt, parseThemes, extractThemes, realClients, safeClients };
