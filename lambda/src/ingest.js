/*
 * Amazon Connect connector: contact records from the Kinesis stream.
 *
 * Every finished contact arrives here a little after it ends. Two jobs:
 *   1. If the contact already has a response row (the IVR or in-chat survey ran in the disconnect flow), fill in
 *      the agent and queue the flow could not know, so reports and Arena attribute the score to the right person.
 *   2. Otherwise, hand the contact to delivery.considerOutbound, which may queue an SMS or email invitation.
 * Our own survey Tasks and contacts without an agent are ignored.
 */
'use strict';
const storeMod = require('./store.js');
const contacts = require('./contacts.js');
const delivery = require('./delivery.js');
const S = require('./surveycx-core.js');

const EMAIL_ATTRIBUTE = process.env.EMAIL_ATTRIBUTE || 'email';
const TENANT_ATTRIBUTE = process.env.TENANT_ATTRIBUTE || '';   // contact attribute naming the tenant or business unit, when one instance serves several

function decode(record) { return JSON.parse(Buffer.from(record.kinesis.data, 'base64').toString('utf8')); }

async function processContact(s, c, nowMs, deps) {
  const nowIso = new Date(nowMs).toISOString();
  if (c.channel === 'task') {
    // Our own low-score Task finishing is the follow-up being done: record who did it and when.
    const target = (c.attributes || {}).surveycx_contact;
    if (!target) return { contactId: c.contactId, action: 'ignored task' };
    const row = await s.getResponse(target);
    if (!row || !row.followUp || row.followUp.status !== 'open') return { contactId: c.contactId, action: 'task for a closed or unknown follow-up' };
    row.followUp = S.closeFollowUp(row.followUp, { status: 'done', by: c.agentName || c.agent || 'connect-task' }, c.endedAt);
    await s.putResponse(row);
    return { contactId: c.contactId, action: 'follow-up closed by task', target };
  }
  const row = await s.getResponse(c.contactId);
  if (row) {
    let changed = false;
    if (c.agent && row.agentArn !== c.agent) { row.agentArn = c.agent; row.agentName = c.agentName || row.agentName; changed = true; }
    if (c.queue && row.queue !== c.queue) { row.queue = c.queue; changed = true; }
    if (!row.customerHash && (c.phone || c.email)) { row.customerHash = s.customerHash(c.phone || c.email); changed = true; }
    if (c.tenant && row.tenant !== c.tenant) { row.tenant = c.tenant; changed = true; }
    if (changed) await s.putResponse(row);
    if (c.agent) await s.touchAgent(c.agent, c.agentName, c.queue, nowIso);
    // The score may have been completed before the agent was known: Arena and the attributes would have gone out without it.
    if (changed && row.status === 'completed' && row.agentArn) await require('./responses.js').closeLoop(row, (await s.getSurvey(row.surveyId)) || { id: row.surveyId, name: row.surveyId, questions: [] }, await s.getSettings(), deps || {});
    return { contactId: c.contactId, action: changed ? 'enriched' : 'unchanged' };
  }
  if (!c.agent) return { contactId: c.contactId, action: 'ignored, no agent' };
  await s.touchAgent(c.agent, c.agentName, c.queue, nowIso);
  const r = await delivery.considerOutbound(s, c, await s.getSettings(), await s.listSurveys(), nowMs);
  return Object.assign({ contactId: c.contactId, action: r.invited ? 'invited ' + r.channel : 'not invited' }, r);
}

function makeHandler(deps) {
  const s = deps.store || storeMod, now = deps.now || (() => Date.now());
  return async (event) => {
    const failures = [];
    for (const record of event.Records || []) {
      try {
        const c = contacts.fromContactRecord(decode(record), EMAIL_ATTRIBUTE, TENANT_ATTRIBUTE);
        if (!c) continue;
        console.log(JSON.stringify(await processContact(s, c, now(), deps)));
      } catch (err) {
        console.error('record failed', record.kinesis && record.kinesis.sequenceNumber, err);
        failures.push({ itemIdentifier: record.kinesis.sequenceNumber });
      }
    }
    return { batchItemFailures: failures };
  };
}

exports.decode = decode; exports.processContact = processContact; exports.makeHandler = makeHandler; exports.handler = makeHandler({});
