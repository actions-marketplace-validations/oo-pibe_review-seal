import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange } from '../lib/classify.js';

const diff = (minus, plus) => ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ...minus.map((l) => '-' + l), ...plus.map((l) => '+' + l)].join('\n');
const rule = (patterns = [], lines = 8) => ({ lines, patterns });

test('no patterns: every change is substantive', () => {
  assert.equal(classifyChange(diff(['a'], ['b']), rule()).substantive, true);
});

test('no text changes is trivial', () => {
  assert.equal(classifyChange('', rule(['only'])).substantive, false);
});

test('big change is substantive even with patterns', () => {
  const r = classifyChange(diff([], Array.from({ length: 8 }, (_, i) => 'line ' + i)), rule(['only']));
  assert.equal(r.substantive, true);
  assert.match(r.why, /touches 8 lines/);
});

test('a new claim is substantive', () => {
  const r = classifyChange(diff(['A fine club.'], ['The only club to win it twice.']), rule(['\\bonly\\b']));
  assert.equal(r.substantive, true);
  assert.match(r.sample, /only club/);
});

test('appending to a paragraph that already had the claim is trivial', () => {
  const before = 'They are the only club to win it twice, and the ground is near the river.';
  const after = before + ' Bring a jacket.';
  assert.equal(classifyChange(diff([before], [after]), rule(['\\bonly\\b'])).substantive, false);
});

test('header lines are never counted as content', () => {
  const d = ['--- a/only.md', '+++ b/only.md', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  assert.equal(classifyChange(d, rule(['only'])).substantive, false);
});

test('binary change is substantive', () => {
  const d = ['diff --git a/i.png b/i.png', 'index 1..2 100644', 'Binary files a/i.png and b/i.png differ'].join('\n');
  const r = classifyChange(d, rule(['only']));
  assert.equal(r.substantive, true);
  assert.equal(r.why, 'binary change');
});

test('pure rename or mode change with no hunks is trivial', () => {
  const d = ['diff --git a/x b/y', 'similarity index 100%', 'rename from x', 'rename to y'].join('\n');
  const r = classifyChange(d, rule(['only']));
  assert.equal(r.substantive, false);
  assert.equal(r.why, 'no text changes');
});

test('a second claim added to a line that already had one is substantive', () => {
  const before = 'They are the only club to win it twice, and the ground is near the river.';
  const after = before + ' They are also the only club never relegated.';
  assert.equal(classifyChange(diff([before], [after]), rule(['\\bonly\\b'])).substantive, true);
});

test('file headers of a second file are not content', () => {
  const d = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/only.md b/only.md', '--- a/only.md', '+++ b/only.md', '@@ -1 +1 @@', '-p', '+q'].join('\n');
  assert.equal(classifyChange(d, rule(['only'])).substantive, false);
});

test('singular wording for one line', () => {
  assert.match(classifyChange(diff(['a'], ['b']), rule(['zzz'])).why, /small edit \(1 line\)/);
  assert.match(classifyChange(diff(['a'], ['b']), rule(['zzz'], 1)).why, /touches 1 line$/);
});
