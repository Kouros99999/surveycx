// The website's release notes page and "latest version" line are built from releases.json,
// and lambda/release.js refuses to publish a version that has no entry. These checks keep the file honest.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs'), path = require('path');
const notes = JSON.parse(fs.readFileSync(path.join(__dirname, 'releases.json'), 'utf8'));
const parts = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

test('every entry has a version, a date, a title, a summary and at least one change', () => {
  assert.ok(notes.length > 0);
  for (const n of notes) {
    assert.match(n.version, /^\d+\.\d+\.\d+$/, 'version ' + n.version);
    assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/, 'date for ' + n.version);
    assert.ok(!Number.isNaN(Date.parse(n.date)), 'real date for ' + n.version);
    assert.ok(n.title && n.summary, 'title and summary for ' + n.version);
    assert.ok(Array.isArray(n.changes) && n.changes.length > 0 && n.changes.every((c) => typeof c === 'string' && c.trim()), 'changes for ' + n.version);
    assert.ok(Array.isArray(n.upgrade), 'upgrade list (may be empty) for ' + n.version);
  }
});

const kb = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb', 'index.json'), 'utf8'));

test('help-center index is well formed and every article file exists', () => {
  const slugs = new Set();
  for (const a of kb) {
    assert.match(a.slug, /^[a-z0-9-]+$/, 'slug ' + a.slug); assert.ok(!slugs.has(a.slug), 'duplicate ' + a.slug); slugs.add(a.slug);
    assert.ok(a.title && a.summary, 'title and summary for ' + a.slug);
    assert.match(a.updated, /^\d+\.\d+\.\d+$/, 'updated version for ' + a.slug);
    assert.ok(fs.existsSync(path.join(__dirname, 'kb', a.slug + '.md')), 'file for ' + a.slug);
    assert.ok(notes.some((n) => n.version === a.updated), `${a.slug} says it is current as of ${a.updated}, which is not a released version`);
  }
});

test('each release names the help-center articles it changed, and they are marked current for it', () => {
  for (const n of notes) {
    assert.ok(Array.isArray(n.docs), 'docs list for ' + n.version);
    for (const slug of n.docs) {
      const a = kb.find((x) => x.slug === slug);
      assert.ok(a, `${n.version} names unknown article ${slug}`);
      assert.ok(!newer(n.version, a.updated), `${slug} was changed in ${n.version} but is marked current as of ${a.updated}`);
    }
  }
});

test('entries are newest first, with no version listed twice', () => {
  for (let i = 1; i < notes.length; i++) {
    assert.ok(newer(notes[i - 1].version, notes[i].version), `${notes[i - 1].version} should be newer than ${notes[i].version}`);
    assert.ok(notes[i - 1].date >= notes[i].date, `${notes[i - 1].version} should not be dated before ${notes[i].version}`);
  }
});
