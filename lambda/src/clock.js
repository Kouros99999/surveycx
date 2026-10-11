/*
 * Local time for a stack. Every "day" in SurveyCX (day rows, streaks, challenge dates, the digest hour,
 * the reward budget month) is a calendar day in the stack's Timezone setting (SURVEYCX_TZ, an IANA name
 * such as America/New_York). The default is UTC, which is what every version used.
 *
 * Pure functions over ISO timestamps or epoch milliseconds; nothing here touches AWS.
 */
'use strict';

const TZ = (() => {
  const want = process.env.SURVEYCX_TZ || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: want }); return want; }
  catch { console.warn(`SURVEYCX_TZ "${want}" is not a valid time zone; using UTC`); return 'UTC'; }
})();

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return fmtCache.get(tz);
}
const toMs = (t) => (typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t));

/** Local calendar parts of an instant: { y, m, d, h, min, s }. */
function parts(t, tz) {
  const out = {};
  for (const p of fmt(tz || TZ).formatToParts(new Date(toMs(t)))) if (p.type !== 'literal') out[p.type] = +p.value;
  return { y: out.year, m: out.month, d: out.day, h: out.hour, min: out.minute, s: out.second };
}
const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD of an instant, in the stack's time zone. */
function dayKey(t, tz) { const p = parts(t, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
/** YYYY-MM of an instant. */
function monthKey(t, tz) { return dayKey(t, tz).slice(0, 7); }
/** Hour of the day, 0-23, in the stack's time zone. */
function hourOf(t, tz) { return parts(t, tz).h; }
/** ISO week (YYYY-Www) of the local date an instant falls on. */
function weekKey(t, tz) { return weekOfDay(dayKey(t, tz)); }
/** ISO week of a YYYY-MM-DD string. Pure date arithmetic, no zone involved. */
function weekOfDay(day) {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));
  const wd = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - wd);
  const y = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${pad(week)}`;
}
/** YYYY-MM-DD plus n days. */
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00.000Z') + n * 86400000).toISOString().slice(0, 10);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The instant (ms) local midnight falls on for a YYYY-MM-DD, in the stack's zone. Two passes absorb the offset, including across a DST change. */
function startOfDay(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess;   // local clock minus UTC at that instant
    guess = target - offset;
  }
  return guess;
}
/** [start, end) of a local day as instants. */
function dayBounds(day, tz) { return { start: startOfDay(day, tz), end: startOfDay(addDays(day, 1), tz) }; }

module.exports = { TZ, parts, dayKey, monthKey, hourOf, weekKey, weekOfDay, addDays, isDay, startOfDay, dayBounds };
