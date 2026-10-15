import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sealRepo, write, run } from './helpers.js';
import { makeEntry } from '../lib/ledger.js';
import { contentHash } from '../lib/hash.js';

function expiredRepo() {
  const r = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgeDays: 30 } } });
  const text = readFileSync(join(r.root, 'docs/guide.md'));
  const rubric = readFileSync(join(r.root, '.seal/rubrics/consistency.md'));
  const old = makeEntry('docs/guide.md', 'consistency', { at: '2020-01-01', contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });
  write(r.root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: old } }));
  r.git('add', '-A'); r.git('commit', '-qm', 'init');
  return r;
}

test('a block only for expiry points at review --due or the file, never at Claude finishing its turn', () => {
  const { root } = expiredRepo();
  const r = run(root, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Fix: past its shelf life; run:\n {7}review-seal review docs\/guide\.md\n {7}\(or review-seal review --due for everything past its shelf life\)/);
  assert.doesNotMatch(r.err, /let Claude finish/);
});

test('an expired file next to a changed one: each gets its own hint', () => {
  const { root } = expiredRepo();
  write(root, 'docs/new.md', 'New page.\n');
  const r = run(root, ['check']);
  assert.match(r.err, /let Claude finish its turn \(reviews run automatically\), or run:\n {7}review-seal review docs\/new\.md\n/);
  assert.match(r.err, /Fix: past its shelf life; run:\n {7}review-seal review docs\/guide\.md\n/);
});

// A lock held by a live process: this test's own pid.
function holdLock(root, pid = process.pid) {
  mkdirSync(join(root, '.seal/.state'), { recursive: true });
  writeFileSync(join(root, '.seal/.state/review.lock'), JSON.stringify({ pid, nonce: 'x' }));
}

test('while a review is running, a blocked commit says to commit again when it finishes', () => {
  const { root, git } = sealRepo();
  git('add', '-A');
  holdLock(root);
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Fix: a review is running now; commit again when it finishes/);
  assert.doesNotMatch(r.err, /let Claude finish/);
});

test('a lock left by a process that has exited does not count as a running review', async () => {
  const { root, git } = sealRepo();
  git('add', '-A');
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((res) => child.on('exit', res));
  holdLock(root, child.pid);
  const r = run(root, ['check', '--staged']);
  assert.doesNotMatch(r.err, /a review is running now/);
  assert.match(r.err, /let Claude finish/);
});

test('expired with open findings that block: still the shelf-life hint, not Claude', () => {
  const r = sealRepo({ blockOnFindings: true, passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgeDays: 30 } } });
  const text = readFileSync(join(r.root, 'docs/guide.md'));
  const rubric = readFileSync(join(r.root, '.seal/rubrics/consistency.md'));
  const old = makeEntry('docs/guide.md', 'consistency', { at: '2020-01-01', contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'findings', findings: ['L1: wrong'], reviewer: 'independent', via: 'agent' });
  write(r.root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: old } }));
  const c = run(r.root, ['check']);
  assert.equal(c.code, 1);
  assert.match(c.err, /Fix: past its shelf life; run:\n {7}review-seal review docs\/guide\.md/);
  assert.doesNotMatch(c.err, /let Claude finish/);
});
