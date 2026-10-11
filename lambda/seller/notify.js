/*
 * AWS Marketplace license lifecycle notifications. Runs in the SELLER account (us-east-1).
 *
 * SaaS products on the concurrent-agreements integration get their notifications from Amazon
 * EventBridge, not SNS: "License Updated - Manufacturer" when a buyer's license is created or
 * changed (usage may be reported) and "License Deprovisioned - Manufacturer" when it ends
 * (about one hour of grace for final usage). Each event carries the LicenseArn, which is the
 * key of the customers table and the identifier the customer's stack meters against.
 */
'use strict';
const TABLE = process.env.CUSTOMERS_TABLE || '';

const STATES = { 'License Updated - Manufacturer': 'active', 'License Deprovisioned - Manufacturer': 'deprovisioned' };

let clients;
function real() {
  if (clients) return clients;
  const ddb = require('@aws-sdk/client-dynamodb'), lib = require('@aws-sdk/lib-dynamodb');
  clients = { ddb: lib.DynamoDBDocumentClient.from(new ddb.DynamoDBClient({})), UpdateCommand: lib.UpdateCommand };
  return clients;
}

/** Pure: turn one EventBridge event into the fields to store, or null when it is not a license event. */
function parseRecord(ev) {
  const state = STATES[ev && ev['detail-type']];
  const d = (ev && ev.detail) || {};
  const licenseArn = d.license && d.license.arn;
  if (!state || !licenseArn) return null;
  return { licenseArn, state, type: ev['detail-type'], at: ev.time || new Date().toISOString(),
    accountId: d.acceptor && d.acceptor.accountId, productCode: d.product && d.product.code, agreementId: d.agreement && d.agreement.id, offerId: d.offer && d.offer.id };
}

exports.handler = async (event, context, deps) => {
  const c = (deps && deps.clients) || real();
  // EventBridge invokes with one event; an SQS or batch wrapper would put several under Records.
  const events = Array.isArray(event.Records) ? event.Records.map((r) => { try { return JSON.parse(r.body || r.Sns?.Message || '{}'); } catch { return null; } }) : [event];
  let handled = 0;
  for (const ev of events) {
    const r = parseRecord(ev);
    if (!r) continue;
    handled++;
    if (TABLE) await c.ddb.send(new c.UpdateCommand({ TableName: TABLE, Key: { licenseArn: r.licenseArn },
      UpdateExpression: 'SET licenseState = :s, lastEvent = :e, lastEventAt = :t, awsAccountId = if_not_exists(awsAccountId, :a), productCode = if_not_exists(productCode, :p), agreementId = :g, offerId = :o',
      ExpressionAttributeValues: { ':s': r.state, ':e': r.type, ':t': r.at, ':a': r.accountId || 'unknown', ':p': r.productCode || 'unknown', ':g': r.agreementId || '', ':o': r.offerId || '' } }));
    console.log(JSON.stringify({ notification: r.type, license: r.licenseArn, account: r.accountId }));
  }
  return { handled };
};

exports.parseRecord = parseRecord;
