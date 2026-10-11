const assert = require('node:assert/strict');
const { test } = require('node:test');
const store = require('./store.js');

test('responseItem adds keys, a day index on the local start day and a retention ttl', () => {
  const it = store.responseItem({ contactId: 'c1', surveyId: 's', startedAt: '2026-10-01T23:30:00Z', status: 'offered' });
  assert.equal(it.pk, 'RESP#c1'); assert.equal(it.sk, 'META'); assert.equal(it.gsi1pk, 'DAY#2026-10-01'); assert.equal(it.gsi1sk, '2026-10-01T23:30:00Z#c1');
  assert.equal(it.ttl, Math.floor(Date.parse('2026-10-01T23:30:00Z') / 1000) + store.RETENTION_DAYS * 86400);
  const fresh = store.responseItem({ contactId: 'c2' }, Date.parse('2026-10-05T10:00:00Z'));
  assert.equal(fresh.startedAt, '2026-10-05T10:00:00.000Z');
});

test('customerHash normalises and never returns the address', () => {
  assert.equal(store.customerHash(' +1 (555) 010-0100 '), store.customerHash('+15550100100'));
  assert.equal(store.customerHash('Ann@Example.com'), store.customerHash('ann@example.com'));
  assert.equal(store.customerHash(''), null);
  assert.equal(store.customerHash('x').length, 32); assert.ok(!store.customerHash('ann@example.com').includes('ann'));
});

test('strip drops table keys', () => { assert.deepEqual(store.strip({ pk: 'a', sk: 'b', gsi1pk: 'c', gsi1sk: 'd', ttl: 1, x: 1 }), { x: 1 }); });
