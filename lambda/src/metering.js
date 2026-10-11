/*
 * SurveyCX usage metering for AWS Marketplace.
 *
 * Runs once a day. Counts the survey responses completed on the previous local day and reports the number as the
 * `responses` dimension (one unit per completed response). Off Marketplace (no PRODUCT_CODE) it stores the count
 * and sends nothing, so pilots and direct deals use the same stack.
 *
 * Idempotent per day. Free trial: for TRIAL_DAYS from the first report, up to TRIAL_RESPONSES a day are not billed.
 */
'use strict';
const clock = require('./clock.js');

const PRODUCT_CODE = process.env.PRODUCT_CODE || '';
const LICENSE_ARN = process.env.LICENSE_ARN || '';
const CUSTOMER_ACCOUNT_ID = process.env.CUSTOMER_ACCOUNT_ID || '';
const DIMENSION = process.env.USAGE_DIMENSION || 'responses';
const TRIAL_DAYS = Math.max(0, +(process.env.TRIAL_DAYS || 0));
const TRIAL_RESPONSES = Math.max(0, +(process.env.TRIAL_RESPONSES || 0));

/** Pure: how many of `count` responses to bill given when the trial started. */
function billable(count, now, trialStartMs, trialDays, trialFree) {
  const inTrial = trialDays > 0 && trialStartMs != null && now < trialStartMs + trialDays * 86400000;
  return { inTrial, billable: inTrial ? Math.max(0, count - trialFree) : count, trialEndsAt: inTrial ? new Date(trialStartMs + trialDays * 86400000).toISOString() : null };
}

let mm;
function metering() {
  if (mm) return mm;
  const { MarketplaceMeteringClient, BatchMeterUsageCommand } = require('@aws-sdk/client-marketplace-metering');
  mm = { client: new MarketplaceMeteringClient({ region: 'us-east-1' }), BatchMeterUsageCommand };
  return mm;
}

async function report(day, count, now, deps) {
  const s = deps.store;
  const prior = await s.getMeter(day);
  if (prior && prior.reported) return { skipped: 'already reported', day, count: prior.count };
  if (!PRODUCT_CODE || !LICENSE_ARN) { await s.putMeter(day, { count, reported: false, note: 'not a Marketplace deployment' }); return { skipped: 'not a Marketplace deployment', day, count }; }
  const trialDays = deps.trialDays != null ? deps.trialDays : TRIAL_DAYS, trialFree = deps.trialResponses != null ? deps.trialResponses : TRIAL_RESPONSES;
  let trialStart = null;
  if (trialDays > 0) {
    const t = await s.getMeter('TRIAL');
    if (t && t.startedAt) trialStart = Date.parse(t.startedAt);
    else { trialStart = now; await s.putMeter('TRIAL', { startedAt: new Date(now).toISOString(), days: trialDays, responses: trialFree }); }
  }
  const trial = billable(count, now, trialStart, trialDays, trialFree);
  const m = deps.metering || metering();
  const r = await m.client.send(new m.BatchMeterUsageCommand({ UsageRecords: [{ Timestamp: new Date(now), CustomerAWSAccountId: CUSTOMER_ACCOUNT_ID, LicenseArn: LICENSE_ARN, Dimension: DIMENSION, Quantity: trial.billable }] }));
  const res = (r.Results || [])[0], bad = (r.UnprocessedRecords || [])[0];
  if (bad) throw new Error('Marketplace did not accept the usage record');
  if (res && res.Status && res.Status !== 'Success' && res.Status !== 'DuplicateRecord') throw new Error('Marketplace usage record status ' + res.Status);
  await s.putMeter(day, { count, billed: trial.billable, trial: trial.inTrial, reported: true, meteringRecordId: res && res.MeteringRecordId, at: new Date(now).toISOString() });
  return { reported: true, day, count, billed: trial.billable, trial: trial.inTrial, trialEndsAt: trial.trialEndsAt, meteringRecordId: res && res.MeteringRecordId };
}

exports.handler = async (event, context, deps) => {
  deps = deps || {};
  const s = deps.store || require('./store.js'); deps.store = s;
  const now = deps.now ? deps.now() : Date.now();
  const day = clock.addDays(clock.dayKey(now), -1);
  const count = (await s.responsesBetween(day, day)).filter((r) => r.status === 'completed' && clock.dayKey(r.completedAt) === day).length;
  const result = await report(day, count, now, deps);
  console.log(JSON.stringify(result));
  return result;
};
exports.billable = billable; exports.report = report;
