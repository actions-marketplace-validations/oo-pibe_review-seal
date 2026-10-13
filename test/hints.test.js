import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, run } from './helpers.js';

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
