const assert = require('node:assert/strict');
const { test } = require('node:test');
const clock = require('./clock.js');

test('UTC keys match the old slice(0, 10) behaviour', () => {
  assert.equal(clock.dayKey('2026-09-15T14:05:30.000Z', 'UTC'), '2026-09-15');
  assert.equal(clock.weekKey('2026-09-15T14:05:30.000Z', 'UTC'), '2026-W38');
  assert.equal(clock.hourOf('2026-09-15T14:05:30.000Z', 'UTC'), 14);
  assert.equal(clock.monthKey('2026-09-15T14:05:30.000Z', 'UTC'), '2026-09');
});

test('a late evening in New York is still the same local day, though UTC has moved on', () => {
  const t = '2026-09-16T02:30:00.000Z';          // 22:30 on the 15th in New York (EDT)
  assert.equal(clock.dayKey(t, 'America/New_York'), '2026-09-15');
  assert.equal(clock.hourOf(t, 'America/New_York'), 22);
  assert.equal(clock.dayKey(t, 'UTC'), '2026-09-16');
  // Sunday night in Los Angeles is still the old ISO week.
  assert.equal(clock.weekKey('2026-09-21T05:00:00.000Z', 'America/Los_Angeles'), '2026-W38');
  assert.equal(clock.weekKey('2026-09-21T05:00:00.000Z', 'UTC'), '2026-W39');
});

test('day bounds are local midnights, also across the DST change', () => {
  const b = clock.dayBounds('2026-09-15', 'America/New_York');
  assert.equal(new Date(b.start).toISOString(), '2026-09-15T04:00:00.000Z');
  assert.equal(new Date(b.end).toISOString(), '2026-09-16T04:00:00.000Z');
  const dst = clock.dayBounds('2026-11-01', 'America/New_York');   // clocks go back that night: a 25-hour day
  assert.equal(new Date(dst.start).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(new Date(dst.end).toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(clock.dayBounds('2026-01-10', 'UTC').start, Date.UTC(2026, 0, 10));
});

test('date arithmetic helpers', () => {
  assert.equal(clock.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(clock.weekOfDay('2026-01-01'), '2026-W01');
  assert.ok(clock.isDay('2026-09-15')); assert.ok(!clock.isDay('2026-9-15'));
  assert.equal(clock.TZ, 'UTC');
});
