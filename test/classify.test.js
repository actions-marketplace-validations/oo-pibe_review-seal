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

test('an edited claim sentence is substantive', () => {
  const r = classifyChange(diff(['They are the only club to win it twice.'], ['They are the only club to win it five times.']), rule(['\\bonly\\b']));
  assert.equal(r.substantive, true);
});

test('a deleted claim is trivial', () => {
  assert.equal(classifyChange(diff(['They are the only club to win it twice. Bring a jacket.'], ['Bring a jacket.']), rule(['\\bonly\\b'])).substantive, false);
});

test('a claim moved verbatim to another line is trivial', () => {
  const claim = 'They are the only club to win it twice.';
  const r = classifyChange(diff([claim + ' The ground is near the river.'], ['The ground is near the river.', claim]), rule(['\\bonly\\b']));
  assert.equal(r.substantive, false);
});

test('abbreviations and decimals do not end a sentence', () => {
  const sub = (a, b) => classifyChange(diff([a], [b]), rule(['\\bonly\\b'])).substantive;
  assert.equal(sub('The only U.S. team to win it twice.', 'The only U.S. team to win it three times.'), true);
  assert.equal(sub('Only 2.5 goals a game.', 'Only 2.9 goals a game.'), true);
  assert.equal(sub('The only club near St. Pauli church.', 'The only club near St. Michael church.'), true);
});

test('appending after a full sentence is trivial even with an abbreviation', () => {
  const before = 'They are the only club to win it twice.';
  assert.equal(classifyChange(diff([before], [before + ' Visit St. Pauli.']), rule(['\\bonly\\b'])).substantive, false);
});

test('narrowing a claim without closing punctuation is substantive', () => {
  const r = classifyChange(diff(['They are the only club in Hamburg to win it'], ['They are the only club in Hamburg']), rule(['\\bonly\\b']));
  assert.equal(r.substantive, true);
});
