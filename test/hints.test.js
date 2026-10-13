import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

test('in GitHub Actions the fix hint points at the review step, not at Claude', () => {
  const { root } = sealRepo();
  const r = run(root, ['check', 'docs/guide.md'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /Fix: the review step above shows why these weren't reviewed; fix and re-run the job/);
  assert.doesNotMatch(r.err, /Claude/);
});

test('after a failed automatic review the hint says it is paused', () => {
  const { root } = sealRepo();
  // An automatic run that fails records a back-off for this version.
  const a = run(root, ['review', '--auto', '--', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'fail' } });
  assert.equal(a.code, 1);
  const r = run(root, ['check', 'docs/guide.md']);
  assert.match(r.err, /automatic review is paused after a failure; run:\n {7}review-seal review docs\/guide\.md/);
  assert.doesNotMatch(r.err, /let Claude finish its turn/);
});

test('with autoReview off the hint does not promise an automatic review', () => {
  const { root } = sealRepo({ autoReview: 'off' });
  const r = run(root, ['check', 'docs/guide.md']);
  assert.match(r.err, /Fix: run:\n {7}review-seal review docs\/guide\.md/);
  assert.doesNotMatch(r.err, /let Claude finish/);
});

test('in GitHub Actions with commit: false the hint says the run\'s reviews were not kept', () => {
  const { root } = sealRepo();
  const r = run(root, ['check', 'docs/guide.md'], { env: { GITHUB_ACTIONS: 'true', REVIEW_SEAL_COMMIT: 'false' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /Fix: this run's reviews were not kept \(commit: false\); record them locally with npx review-seal review docs\/guide\.md and push the ledger/);
  assert.doesNotMatch(r.err, /re-run the job/);
});

test('the action tells the check step whether reviews are committed', () => {
  const y = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const check = y.split('- name: Check\n')[1].split('\n    - name:')[0];
  assert.match(check, /REVIEW_SEAL_COMMIT: \$\{\{ inputs\.commit \}\}/);
});

test('the settings block says how to split the change', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'base');
  write(root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgeDays: 9 } } }));
  write(root, 'src/app.js', 'console.log(2);\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /split it: git restore --staged src\/app\.js, commit \.seal\/ alone, then commit the rest/);
});

test('under a hook manager that puts node_modules/.bin on PATH, hints still say npx review-seal', () => {
  const { root } = sealRepo();
  const bin = join(root, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'review-seal'), '#!/bin/sh\n');
  chmodSync(join(bin, 'review-seal'), 0o755);
  const PATH = [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const r = run(root, ['check', 'docs/guide.md'], { env: { PATH } });
  assert.match(r.err, /^ {7}npx review-seal review docs\/guide\.md$/m);
});
