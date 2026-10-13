import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueBody, renewedEntries } from '../lib/due.js';
import { makeEntry } from '../lib/ledger.js';

const H = 'sha256:0123456789abcdef';
const entry = (file, at, verdict, findings = []) => makeEntry(file, 'consistency', { at, contentHash: H, rubricHash: H, verdict, findings, reviewer: 'independent', via: 'agent' });

test('renewedEntries lists entries that are new or changed against the base, and skips invalid ones', () => {
  const kept = entry('docs/a.md', '2026-01-01', 'clean');
  const base = { 'docs/a.md': { consistency: kept }, 'docs/b.md': { consistency: entry('docs/b.md', '2026-01-01', 'clean') } };
  const next = {
    'docs/a.md': { consistency: kept },
    'docs/b.md': { consistency: entry('docs/b.md', '2026-10-01', 'findings', ['L2: wrong']) },
    'docs/c.md': { consistency: entry('docs/c.md', '2026-10-01', 'clean') },
    'docs/d.md': { consistency: { ...entry('docs/d.md', '2026-10-01', 'clean'), verdict: 'findings' } },
  };
  assert.deepEqual(renewedEntries(JSON.stringify(base), JSON.stringify(next)).map((r) => r.file), ['docs/b.md', 'docs/c.md']);
  assert.deepEqual(renewedEntries('not json', JSON.stringify(next)).map((r) => r.file), ['docs/a.md', 'docs/b.md', 'docs/c.md']);
});

test('dueBody shows renewed reviews with findings, fenced and sanitised, then the log', () => {
  const next = { 'docs/b.md': { consistency: entry('docs/b.md', '2026-10-01', 'findings', ['L2: @someone ~~~~ \x1b[31mred']) } };
  const body = dueBody({ baseLedger: '{}', newLedger: JSON.stringify(next), log: 'reviewing docs/b.md [consistency]\n' });
  assert.match(body, /Reviews this pull request renews \(1\):\n\n~~~~~\ndocs\/b\.md \[consistency\] findings \(reviewed 2026-10-01\)\n {4}L2: @someone ~~~~ \[31mred\n~~~~~\n/);
  assert.match(body, /Log of the latest run:\n\n~~~\nreviewing docs\/b\.md \[consistency\]\n~~~\n$/);
  assert.doesNotMatch(body, /\x1b/);
  assert.doesNotMatch(dueBody({ log: 'x' }), /renews/);
});
