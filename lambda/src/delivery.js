/*
 * Outbound invitations: whether to invite a customer after a contact, and the governance around it.
 *
 * considerOutbound() runs for every finished contact that did not get an in-channel survey (voice IVR, in-chat).
 * It picks the survey, applies sampling, the frequency cap, the opt-out list and the quiet-hour window, creates the
 * response row with its web token and queues the SMS or email in the outbox. sendDue() is the scheduled worker
 * that drains the outbox, and queues one reminder when the settings ask for it.
 *
 * Settings (CONFIG/SETTINGS.delivery):
 *   frequencyDays   do not invite the same phone/email again within this many days (default 30)
 *   quietStart/End  local hours (stack time zone) outside which nothing is sent; sends are queued to the next window (default 8-21)
 *   reminderHours   0 = no reminder; otherwise one reminder after this many hours if the survey is still unanswered
 *   smsText/emailSubject/emailText  templates; {link} is the survey link, {brand} the company name
 *   smsOrigination  phone number, sender id or pool ARN in AWS End User Messaging (also the SMS_ORIGINATION env)
 *   emailFrom       a verified SES sender (also the EMAIL_FROM env)
 */
'use strict';
const S = require('./surveycx-core.js');
const clock = require('./clock.js');
const responses = require('./responses.js');

const DEFAULTS = { frequencyDays: 30, quietStart: 8, quietEnd: 21, reminderHours: 0, smsText: '{brand}: thanks for contacting us today. Could you answer 3 quick questions? {link} Reply STOP to opt out.', emailSubject: 'How did we do today?', emailText: 'Thank you for contacting {brand}. Please take a minute to tell us how we did: {link}\n\nIf you would rather not be surveyed, use the link at the bottom of the survey page.' };
const settingsOf = (settings) => Object.assign({}, DEFAULTS, (settings && settings.delivery) || {});

/** Pure: the next instant inside the send window, or `nowMs` itself when already inside it. */
function nextSendTime(nowMs, quietStart, quietEnd) {
  const h = clock.hourOf(nowMs);
  if (h >= quietStart && h < quietEnd) return nowMs;
  const day = clock.dayKey(nowMs);
  const todayStart = clock.startOfDay(day) + quietStart * 3600000;
  return h < quietStart ? todayStart : clock.startOfDay(clock.addDays(day, 1)) + quietStart * 3600000;
}

/** Pure: which outbound channel a survey can use for this contact, if any. SMS first when both are possible. */
function channelFor(survey, contact) {
  if (contact.phone && survey.target.channels.includes('sms')) return 'sms';
  if (contact.email && survey.target.channels.includes('email')) return 'email';
  return null;
}

/** Decide and queue. Returns { invited: boolean, reason, channel } for logs and the ingest route's reply. */
async function considerOutbound(store, contact, settings, surveys, nowMs) {
  const d = settingsOf(settings);
  if (!contact.phone && !contact.email) return { invited: false, reason: 'no phone or email' };
  const existing = await store.getResponse(contact.contactId);
  if (existing) return { invited: false, reason: 'already surveyed' };
  // Which survey, judged on the outbound channels: a voice-only survey never sends an SMS.
  const candidates = (surveys || []).filter((x) => x.status === 'active' && (x.target.channels.includes('sms') || x.target.channels.includes('email')));
  const survey = S.pickSurvey(candidates.map((x) => Object.assign({}, x, { target: Object.assign({}, x.target, { channels: ['sms', 'email', contact.channel] }) })), contact);
  if (!survey) return { invited: false, reason: 'no survey for this contact' };
  const real = candidates.find((x) => x.id === survey.id);
  const channel = channelFor(real, contact);
  if (!channel) return { invited: false, reason: 'survey channels do not match the contact' };
  if (!S.sampled(contact.contactId, real.target.sample)) return { invited: false, reason: 'not sampled' };
  const hash = store.customerHash(channel === 'sms' ? contact.phone : contact.email);
  const cust = await store.getCustomer(hash);
  if (cust && cust.optOut) return { invited: false, reason: 'opted out' };
  if (cust && cust.lastInvitedAt && Date.parse(cust.lastInvitedAt) > nowMs - d.frequencyDays * 86400000) return { invited: false, reason: 'invited within ' + d.frequencyDays + ' days' };
  const nowIso = new Date(nowMs).toISOString();
  const row = await responses.offer(store, contact, real, channel, nowIso, { customerHash: hash });
  const dueAt = new Date(nextSendTime(nowMs, d.quietStart, d.quietEnd)).toISOString();
  await store.enqueue({ contactId: contact.contactId, channel, to: channel === 'sms' ? contact.phone : contact.email, dueAt, kind: 'invite', token: row.token, surveyId: real.id });
  await store.touchCustomer(hash, { lastInvitedAt: nowIso, channel });
  return { invited: true, channel, dueAt, reason: dueAt === nowIso ? 'queued' : 'queued for the send window' };
}

/** Pure: fill a template. */
const render = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

/** Drain the outbox: send what is due, queue reminders, drop sends for completed or opted-out responses. */
async function sendDue(store, settings, clients, nowMs, siteUrl) {
  const d = settingsOf(settings), brand = (settings.brand && settings.brand.name) || 'Customer care';
  const nowIso = new Date(nowMs).toISOString();
  let sent = 0, dropped = 0, reminders = 0;
  for (const item of await store.dueSends(nowIso)) {
    const row = await store.getResponse(item.contactId);
    const cust = row && (await store.getCustomer(row.customerHash));
    if (!row || row.status === 'completed' || (cust && cust.optOut) || (item.kind === 'reminder' && row.status !== 'offered')) { await store.deleteSend(item.sk); dropped++; continue; }
    const link = `${siteUrl}/survey.html#${item.token || row.token}`;
    const vars = { link, brand };
    try {
      if (item.channel === 'sms') {
        const origination = d.smsOrigination || process.env.SMS_ORIGINATION;
        if (!origination) throw new Error('no SMS origination identity configured');
        await clients.sms.send(new clients.SendTextMessageCommand({ DestinationPhoneNumber: item.to, OriginationIdentity: origination, MessageBody: render(d.smsText, vars), MessageType: 'TRANSACTIONAL' }));
      } else {
        const from = d.emailFrom || process.env.EMAIL_FROM;
        if (!from) throw new Error('no email sender configured');
        await clients.ses.send(new clients.SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: [item.to] }, Content: { Simple: { Subject: { Data: render(d.emailSubject, vars) }, Body: { Text: { Data: render(d.emailText, vars) }, Html: { Data: emailHtml(render(d.emailText, vars), link, brand, row, settings) } } } } }));
      }
      sent++;
      row.sentAt = row.sentAt || nowIso; row.sends = (row.sends || 0) + 1;
      await store.putResponse(row);
      await store.deleteSend(item.sk);
      if (item.kind === 'invite' && d.reminderHours > 0) { await store.enqueue(Object.assign({}, item, { kind: 'reminder', dueAt: new Date(nextSendTime(nowMs + d.reminderHours * 3600000, d.quietStart, d.quietEnd)).toISOString() })); reminders++; }
    } catch (e) {
      console.error(JSON.stringify({ send: item.channel, contactId: item.contactId, error: e.name || e.message }));
      row.sendError = String(e.message || e).slice(0, 200); await store.putResponse(row);
      await store.deleteSend(item.sk); dropped++;   // one attempt; the error is on the response row for the console to show
    }
  }
  return { sent, dropped, reminders };
}

/** One-click rating in the email: the first rating question's buttons link straight into the survey with the answer. */
function emailHtml(text, link, brand, row, settings) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const accent = (settings.brand && settings.brand.accent) || '#0f766e';
  const buttons = [1, 2, 3, 4, 5].map((n) => `<a href="${esc(link)}&a=${n}" style="display:inline-block;margin:0 4px;padding:10px 14px;border:1px solid ${accent};border-radius:6px;color:${accent};text-decoration:none;font-weight:600">${n}</a>`).join('');
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,sans-serif;color:#15181e;line-height:1.5;max-width:36rem;margin:0 auto;padding:16px"><p>${esc(text).replace(/\n/g, '<br>')}</p><p style="margin:20px 0 6px"><b>How satisfied were you?</b> 1 = very dissatisfied, 5 = very satisfied</p><p>${buttons}</p><p><a href="${esc(link)}" style="color:${accent}">Open the full survey</a></p><p style="color:#6b7280;font-size:12px">${esc(brand)}. If you would rather not be surveyed, use the link at the bottom of the survey page.</p></body></html>`;
}

let clients;
function realClients() {
  if (clients) return clients;
  const sms = require('@aws-sdk/client-pinpoint-sms-voice-v2'), ses = require('@aws-sdk/client-sesv2');
  clients = { sms: new sms.PinpointSMSVoiceV2Client({}), SendTextMessageCommand: sms.SendTextMessageCommand, ses: new ses.SESv2Client({}), SendEmailCommand: ses.SendEmailCommand };
  return clients;
}

/** Scheduled Lambda: every few minutes, send what is due. */
async function handler(event, context, deps) {
  deps = deps || {};
  const s = deps.store || require('./store.js');
  const r = await sendDue(s, await s.getSettings(), deps.clients || realClients(), deps.now ? deps.now() : Date.now(), process.env.SITE_URL || '');
  console.log(JSON.stringify(r));
  return r;
}

module.exports = { DEFAULTS, settingsOf, nextSendTime, channelFor, considerOutbound, sendDue, render, emailHtml, handler, realClients };
