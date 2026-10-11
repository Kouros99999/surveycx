const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.PRODUCT_CODE = 'prod-1'; process.env.LICENSE_ARN = 'arn:lic'; process.env.CUSTOMER_ACCOUNT_ID = '111122223333';
const metering = require('./metering.js');
const mem = require('./memstore.js');

const fakeMetering = (calls) => ({ client: { send: async (c) => { calls.push(c.input); return { Results: [{ Status: 'Success', MeteringRecordId: 'm-1' }] }; } }, BatchMeterUsageCommand: function (i) { this.input = i; } });

test('billable applies the trial allowance only inside the trial', () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  assert.deepEqual(metering.billable(120, start + 86400000, start, 30, 100), { inTrial: true, billable: 20, trialEndsAt: '2026-10-31T00:00:00.000Z' });
  assert.equal(metering.billable(120, start + 31 * 86400000, start, 30, 100).billable, 120);
  assert.equal(metering.billable(5, start, null, 0, 100).billable, 5);
});

test('handler counts yesterday\'s completed responses, reports once, and starts the trial clock', async () => {
  const s = mem.make();
  for (let i = 0; i < 3; i++) await s.putResponse({ contactId: 'c' + i, surveyId: 'd', status: i < 2 ? 'completed' : 'started', startedAt: '2026-10-10T10:00:00Z', completedAt: i < 2 ? '2026-10-10T10:05:00Z' : undefined, answers: {} });
  await s.putResponse({ contactId: 'today', surveyId: 'd', status: 'completed', startedAt: '2026-10-11T01:00:00Z', completedAt: '2026-10-11T01:05:00Z', answers: {} });
  const calls = [];
  const r = await metering.handler({}, {}, { store: s, now: () => Date.parse('2026-10-11T03:15:00Z'), metering: fakeMetering(calls), trialDays: 30, trialResponses: 1 });
  assert.equal(r.day, '2026-10-10'); assert.equal(r.count, 2); assert.equal(r.billed, 1); assert.equal(r.trial, true); assert.equal(r.meteringRecordId, 'm-1');
  assert.equal(calls[0].UsageRecords[0].Dimension, 'responses'); assert.equal(calls[0].UsageRecords[0].LicenseArn, 'arn:lic'); assert.equal(calls[0].UsageRecords[0].Quantity, 1);
  const again = await metering.handler({}, {}, { store: s, now: () => Date.parse('2026-10-11T04:15:00Z'), metering: fakeMetering(calls) });
  assert.equal(again.skipped, 'already reported'); assert.equal(calls.length, 1);
  assert.ok((await s.getMeter('TRIAL')).startedAt);
});
