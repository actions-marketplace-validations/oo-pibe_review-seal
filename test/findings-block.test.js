import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, write, run } from './helpers.js';

const blocking = (over = {}) => {
  const r = sealRepo({ blockOnFindings: true, ...over });
  run(r.root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  r.git('add', '-A');
  return r;
};

test('blockOnFindings: a fresh review with findings says to fix the file, not to review it again', () => {
  const { root } = blocking();
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /review-seal: open findings block this commit:\n\n {2}BLOCK {2}docs\/guide\.md \[consistency\] open finding/);
  assert.match(r.err, /Fix: edit the file to address the findings; it will be re-reviewed automatically \(or run review-seal review docs\/guide\.md\)/);
  assert.doesNotMatch(r.err, /need a fresh independent review/);
  assert.doesNotMatch(r.err, /let Claude finish/);
  // And the command it names does something once the file changes: on the reviewed text it has nothing to do.
  assert.match(run(root, ['review', 'docs/guide.md']).out, /nothing needs review/);
});

test('blockOnFindings in CI: fix the findings and push', () => {
  const { root } = blocking();
  const r = run(root, ['check', 'docs/guide.md'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /Fix: fix the findings and push; the review re-runs/);
  assert.doesNotMatch(r.err, /re-run the job|need a fresh independent review/);
});

test('blockOnFindings with autoReview off: edit, then run the review', () => {
  const { root } = blocking({ autoReview: 'off' });
  const r = run(root, ['check', 'docs/guide.md']);
  assert.match(r.err, /Fix: edit the file to address the findings, then run:\n {7}review-seal review docs\/guide\.md/);
  assert.doesNotMatch(r.err, /re-reviewed automatically/);
});

test('blockOnFindings: a file changed since its findings review is listed as needing a review, not under findings', () => {
  const { root, git } = blocking();
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport or an ID card, and children go free when they come with an adult.\nMore text here.\nAnd more.\nAnd more.\nAnd more.\nAnd more.\nAnd more.\nAnd more.\nAnd more.\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /these files need a fresh independent review before this commit/);
  assert.doesNotMatch(r.err, /open findings block/);
});

test('blockOnFindings in CI: findings that block show as error annotations on their lines', () => {
  const { root } = blocking();
  const r = run(root, ['check', 'docs/guide.md'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.match(r.out, /^::error file=docs\/guide\.md,line=1,title=review-seal consistency::L1: says passport here, tax number elsewhere$/m);
  assert.doesNotMatch(r.out, /::warning/);
  // Outside CI, no workflow commands.
  assert.doesNotMatch(run(root, ['check', 'docs/guide.md']).out, /::error/);
});

test('error annotations escape the file, title and finding like warnings do', () => {
  const { root, git } = sealRepo({ blockOnFindings: true, passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'] } } });
  write(root, 'docs/a,b:c.md', 'Text.\n');
  run(root, ['review', 'docs/a,b:c.md'], { env: { FAKE_CLAUDE_MODE: 'custom', FAKE_CLAUDE_FINDINGS: JSON.stringify(['L1: 50% off\nnext::end']) } });
  git('add', '-A');
  const r = run(root, ['check', '--staged'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 1);
  const line = r.out.split('\n').find((l) => l.startsWith('::error'));
  assert.ok(line, r.out);
  assert.match(line, /^::error file=docs\/a%2Cb%3Ac\.md,line=1,title=review-seal consistency::L1: 50%25 off/);
  assert.equal(r.out.split('\n').filter((l) => /^::/.test(l)).length, 1);
});
