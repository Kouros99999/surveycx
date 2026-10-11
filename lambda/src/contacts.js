/*
 * SurveyCX's canonical contact: the one thing a platform connector has to produce.
 *
 * Amazon Connect's contact records, the generic ingest endpoint (Genesys, NICE, Five9, middleware) and the IVR
 * flow all describe a finished contact in this shape. Everything above it, from targeting to reports, is
 * platform-neutral.
 *
 *   contactId   the platform's id for the interaction (required)
 *   channel     voice | chat | email | task (the channel the contact happened on)
 *   agent       the platform's id for the person who handled it (ARN on Connect); agentName optional
 *   queue       queue or skill name
 *   attributes  { name: value } the platform attached to the contact
 *   phone       customer's phone number in E.164, for SMS invitations
 *   email       customer's email, for email invitations
 *   endedAt     ISO time the contact ended
 *   platform    connect | genesys | ... (wording only)
 *   tenant      the partner's tenant or business unit the contact belongs to; reports can be split by it
 */
'use strict';
const str = (v, max) => (v == null ? undefined : String(v).trim().slice(0, max || 200) || undefined);
const CHANNELS = ['voice', 'chat', 'email', 'task'];

function normalizeContact(e, nowIso) {
  if (!e || typeof e !== 'object') throw new Error('each contact must be an object');
  const contactId = str(e.contactId, 200);
  if (!contactId) throw new Error('contactId is required');
  const channel = (str(e.channel, 20) || 'voice').toLowerCase();
  if (!CHANNELS.includes(channel)) throw new Error(`channel must be one of ${CHANNELS.join(', ')}`);
  const endedAt = e.endedAt ? new Date(e.endedAt) : new Date(nowIso || Date.now());
  if (isNaN(endedAt)) throw new Error('endedAt must be an ISO 8601 time');
  const phone = str(e.phone, 30), email = str(e.email, 200);
  if (phone && !/^\+?[1-9]\d{6,14}$/.test(phone.replace(/[\s()-]/g, ''))) throw new Error('phone must be an E.164 number');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email must be an address');
  const attrs = {};
  if (e.attributes && typeof e.attributes === 'object') for (const k of Object.keys(e.attributes).slice(0, 50)) attrs[str(k, 120)] = str(e.attributes[k], 500) || '';
  const out = { contactId, channel, agent: str(e.agent, 300), agentName: str(e.agentName, 120), queue: str(e.queue, 120), attributes: attrs, phone: phone ? '+' + phone.replace(/[^\d]/g, '') : undefined, email: email ? email.toLowerCase() : undefined, endedAt: endedAt.toISOString(), platform: str(e.platform, 40) || 'generic', tenant: str(e.tenant, 80) };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Amazon Connect contact record (CTR) -> canonical contact. Pure. Returns null for records that are not finished contacts. */
function fromContactRecord(ctr, emailAttribute, tenantAttribute) {
  if (!ctr || !ctr.ContactId || !ctr.DisconnectTimestamp) return null;
  const ch = String(ctr.Channel || 'VOICE').toLowerCase();
  const agent = ctr.Agent || {};
  const ep = ctr.CustomerEndpoint || {};
  const attrs = ctr.Attributes || {};
  const phone = ep.Type === 'TELEPHONE_NUMBER' && ep.Address ? ep.Address : undefined;
  const email = (emailAttribute && attrs[emailAttribute]) || (ep.Type === 'EMAIL_ADDRESS' ? ep.Address : undefined);
  const name = [agent.FirstName, agent.LastName].filter(Boolean).join(' ') || agent.Username;
  try {
    return normalizeContact({ contactId: ctr.ContactId, channel: ch === 'voice' || ch === 'chat' || ch === 'task' || ch === 'email' ? ch : 'voice', agent: agent.ARN, agentName: name, queue: ctr.Queue && ctr.Queue.Name, attributes: attrs, phone, email, endedAt: ctr.DisconnectTimestamp, platform: 'connect', tenant: tenantAttribute ? attrs[tenantAttribute] : undefined });
  } catch (e) {
    // A bad phone or email on the record must not lose the contact: drop the bad address and keep going.
    return normalizeContact({ contactId: ctr.ContactId, channel: ch === 'chat' ? 'chat' : 'voice', agent: agent.ARN, agentName: name, queue: ctr.Queue && ctr.Queue.Name, attributes: attrs, endedAt: ctr.DisconnectTimestamp, platform: 'connect', tenant: tenantAttribute ? attrs[tenantAttribute] : undefined });
  }
}

module.exports = { CHANNELS, normalizeContact, fromContactRecord };
