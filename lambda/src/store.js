/*
 * DynamoDB layer shared by every SurveyCX Lambda. One table, on demand.
 *
 *   pk=CONFIG            sk=SURVEY#<id>            survey definition (surveycx-core normalizeSurvey shape)
 *   pk=CONFIG            sk=SETTINGS               closed loop, delivery, Arena feed, brand, retention
 *   pk=RESP#<contactId>  sk=META                   one response per contact: survey, agent, queue, channel, status, answers, scores. ttl = retention
 *                                                  gsi1pk=DAY#<local day of startedAt>  gsi1sk=<startedAt>#<contactId>
 *   pk=TOKEN#<token>     sk=LINK                   web survey token -> contactId. ttl = link expiry
 *   pk=CUST#<hash>       sk=LAST                   per customer (hashed phone or email): lastInvitedAt, optOut. Frequency cap and STOP.
 *   pk=OUTBOX            sk=<dueAt>#<contactId>    queued SMS/email sends (quiet hours, reminders)
 *   pk=KEY#<key>         sk=META                   ingest and data keys for other platforms and BI tools
 *   pk=AGENT#<arn>       sk=LIVE                   agent name and queue as last seen, for lists and reports
 *   pk=METER             sk=<day> | TRIAL          Marketplace usage reports (and THEMES#<day> markers)
 *   pk=THEMES            sk=<surveyId|*>#<day>    daily verbatim themes for the trailing window
 */
'use strict';
const clock = require('./clock.js');

const TABLE = process.env.TABLE || 'surveycx';
const RETENTION_DAYS = Math.max(30, +(process.env.RETENTION_DAYS || 400));

let ddb, cmds;
function db() {
  if (ddb) return ddb;
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const lib = require('@aws-sdk/lib-dynamodb');
  cmds = lib;
  ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return ddb;
}
const ttlAt = (ms, days) => Math.floor(ms / 1000) + days * 86400;
const strip = (item) => { if (!item) return item; const { pk, sk, gsi1pk, gsi1sk, ttl, ...rest } = item; return rest; };

/** Pure: the stored shape of a response row with its index keys and retention. */
function responseItem(r, nowMs) {
  const startedAt = r.startedAt || new Date(nowMs || Date.now()).toISOString();
  return Object.assign({}, r, { pk: 'RESP#' + r.contactId, sk: 'META', startedAt, gsi1pk: 'DAY#' + clock.dayKey(startedAt), gsi1sk: startedAt + '#' + r.contactId, ttl: ttlAt(Date.parse(startedAt), RETENTION_DAYS) });
}

/** Pure: hash a phone number or email so the table never holds the raw address. */
function customerHash(address) {
  const norm = String(address || '').trim().toLowerCase().replace(/[^a-z0-9@+.]/g, '');
  if (!norm) return null;
  return require('crypto').createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

async function get(pk, sk) { return strip((await db().send(new cmds.GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item); }
async function put(item) { await db().send(new cmds.PutCommand({ TableName: TABLE, Item: item })); }
async function del(pk, sk) { await db().send(new cmds.DeleteCommand({ TableName: TABLE, Key: { pk, sk } })); }
async function query(params) {
  const out = []; let key;
  do {
    const r = await db().send(new cmds.QueryCommand(Object.assign({ TableName: TABLE, ExclusiveStartKey: key }, params)));
    out.push(...(r.Items || [])); key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

// ---------- surveys and settings ----------
async function listSurveys() { return (await query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': 'CONFIG', ':s': 'SURVEY#' } })).map(strip); }
async function getSurvey(id) { return get('CONFIG', 'SURVEY#' + id); }
async function putSurvey(s) { await put(Object.assign({ pk: 'CONFIG', sk: 'SURVEY#' + s.id }, s)); }
async function deleteSurvey(id) { await del('CONFIG', 'SURVEY#' + id); }
async function getSettings() { return (await get('CONFIG', 'SETTINGS')) || {}; }
async function putSettings(s) { await put(Object.assign({ pk: 'CONFIG', sk: 'SETTINGS' }, s)); }

// ---------- responses ----------
async function getResponse(contactId) { return strip(await get('RESP#' + contactId, 'META')); }
async function putResponse(r, nowMs) { await put(responseItem(r, nowMs)); }
/** All responses whose startedAt falls on the local days from..to inclusive (YYYY-MM-DD), newest last. */
async function responsesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = clock.addDays(d, 1)) out.push(...(await query({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': 'DAY#' + d } })).map(strip));
  return out;
}
async function deleteResponse(contactId) { const r = await getResponse(contactId); if (r && r.token) await del('TOKEN#' + r.token, 'LINK'); await del('RESP#' + contactId, 'META'); return !!r; }
/** Every response for a customer hash (a deletion request). Scans; rare. */
async function responsesForCustomer(hash) {
  const out = []; let key;
  do {
    const r = await db().send(new cmds.ScanCommand({ TableName: TABLE, FilterExpression: 'customerHash = :h AND sk = :m', ExpressionAttributeValues: { ':h': hash, ':m': 'META' }, ExclusiveStartKey: key }));
    out.push(...(r.Items || []).map(strip)); key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

// ---------- web survey tokens ----------
async function putToken(token, contactId, expiresMs) { await put({ pk: 'TOKEN#' + token, sk: 'LINK', contactId, ttl: Math.floor(expiresMs / 1000) }); }
async function getToken(token) { const t = await get('TOKEN#' + token, 'LINK'); return t ? t.contactId : null; }

// ---------- customers: frequency cap and opt-out ----------
async function getCustomer(hash) { return hash ? get('CUST#' + hash, 'LAST') : null; }
async function touchCustomer(hash, patch) {
  if (!hash) return;
  const names = Object.keys(patch);
  await db().send(new cmds.UpdateCommand({ TableName: TABLE, Key: { pk: 'CUST#' + hash, sk: 'LAST' },
    UpdateExpression: 'SET ' + names.map((n) => `#${n} = :${n}`).join(', ') + ', #ttl = :ttl',
    ExpressionAttributeNames: Object.assign({ '#ttl': 'ttl' }, ...names.map((n) => ({ ['#' + n]: n }))),
    ExpressionAttributeValues: Object.assign({ ':ttl': ttlAt(Date.now(), RETENTION_DAYS) }, ...names.map((n) => ({ [':' + n]: patch[n] }))) }));
}

// ---------- outbox ----------
async function enqueue(send) { await put(Object.assign({ pk: 'OUTBOX', sk: send.dueAt + '#' + send.contactId, ttl: ttlAt(Date.parse(send.dueAt), 7) }, send)); }
async function dueSends(nowIso) { return (await query({ KeyConditionExpression: 'pk = :p AND sk <= :s', ExpressionAttributeValues: { ':p': 'OUTBOX', ':s': nowIso + '#~' } })).map((i) => Object.assign(strip(i), { sk: i.sk })); }
async function deleteSend(sk) { await del('OUTBOX', sk); }

// ---------- keys ----------
async function listKeys() { const r = await db().send(new cmds.ScanCommand({ TableName: TABLE, FilterExpression: 'begins_with(pk, :p)', ExpressionAttributeValues: { ':p': 'KEY#' } })); return (r.Items || []).map((i) => Object.assign(strip(i), { key: i.pk.slice(4) })); }
async function getKey(key) { return get('KEY#' + key, 'META'); }
async function putKey(key, meta) { await put(Object.assign({ pk: 'KEY#' + key, sk: 'META' }, meta)); }
async function deleteKey(key) { await del('KEY#' + key, 'META'); }

// ---------- agents ----------
async function touchAgent(arn, name, queue, atIso) {
  if (!arn) return;
  // A real name overwrites; without one, keep whatever name we already have.
  await db().send(new cmds.UpdateCommand({ TableName: TABLE, Key: { pk: 'AGENT#' + arn, sk: 'LIVE' },
    UpdateExpression: name ? 'SET lastSeen = :t, #n = :n, queue = :q' : 'SET lastSeen = :t, #n = if_not_exists(#n, :n), queue = :q',
    ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':t': atIso, ':n': name || arn.split('/').pop(), ':q': queue || 'unassigned' } }));
}
async function listAgents() { const r = await db().send(new cmds.ScanCommand({ TableName: TABLE, FilterExpression: 'begins_with(pk, :p) AND sk = :l', ExpressionAttributeValues: { ':p': 'AGENT#', ':l': 'LIVE' } })); return (r.Items || []).map((i) => Object.assign(strip(i), { arn: i.pk.slice(6) })); }

// ---------- metering ----------
async function getMeter(day) { return get('METER', day); }

// ---------- verbatim themes ----------
async function putThemes(surveyId, day, data) { await put(Object.assign({ pk: 'THEMES', sk: `${surveyId}#${day}`, ttl: ttlAt(Date.now(), RETENTION_DAYS) }, data)); }
/** The newest themes for a survey (or '*' for all) on or before a day. */
async function getThemes(surveyId, day) { const r = await db().send(new cmds.QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': 'THEMES', ':a': `${surveyId}#0000-00-00`, ':b': `${surveyId}#${day}` }, ScanIndexForward: false, Limit: 1 })); return strip((r.Items || [])[0]); }
async function putMeter(day, data) { await put(Object.assign({ pk: 'METER', sk: day }, data)); }

module.exports = { TABLE, RETENTION_DAYS, responseItem, customerHash, strip,
  listSurveys, getSurvey, putSurvey, deleteSurvey, getSettings, putSettings,
  getResponse, putResponse, responsesBetween, deleteResponse, responsesForCustomer, putToken, getToken,
  getCustomer, touchCustomer, enqueue, dueSends, deleteSend, listKeys, getKey, putKey, deleteKey, touchAgent, listAgents, getMeter, putMeter, putThemes, getThemes };
