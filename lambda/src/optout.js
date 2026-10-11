/*
 * STOP handling for SMS. AWS End User Messaging delivers inbound messages to an SNS topic; this Lambda is subscribed
 * to it and marks the sender opted out when the message is a stop word, so no invitation or reminder goes to them
 * again. Opt-outs made from the survey page land in the same place through the API.
 */
'use strict';
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|arret|stopp)\b/i;

/** Pure: the phone number and whether the text is a stop request, from one SNS record. */
function parseRecord(rec) {
  let msg = rec && rec.Sns && rec.Sns.Message;
  try { msg = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch { return null; }
  if (!msg) return null;
  const from = msg.originationNumber || msg.OriginationNumber || msg.originationPhoneNumber;
  const body = msg.messageBody || msg.MessageBody || '';
  if (!from) return null;
  return { from, stop: STOP.test(String(body)), body: String(body).slice(0, 200) };
}

function makeHandler(deps) {
  const s = deps.store || require('./store.js');
  return async (event) => {
    let optedOut = 0;
    for (const rec of event.Records || []) {
      const p = parseRecord(rec);
      if (!p || !p.stop) continue;
      await s.touchCustomer(s.customerHash(p.from), { optOut: true, optOutAt: new Date().toISOString(), optOutVia: 'sms' });
      optedOut++;
    }
    console.log(JSON.stringify({ optedOut }));
    return { optedOut };
  };
}

exports.parseRecord = parseRecord; exports.makeHandler = makeHandler; exports.handler = makeHandler({});
