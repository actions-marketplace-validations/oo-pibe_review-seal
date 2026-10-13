import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

const hook = (root, event, payload) => run(root, ['hook', event], { input: JSON.stringify({ session_id: 's1', cwd: root, ...payload }) });
const ctx = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : '');

test('bare check says the file changed, without "(explicit check)"', () => {
  const { root } = sealRepo();
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  write(root, 'docs/guide.md', 'Changed.\n');
  const r = run(root, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /then the file changed$/m);
  assert.doesNotMatch(r.err, /explicit check/);
});

test('the edit hook says "has no review yet" for a file never reviewed, and "out of date" after a review', () => {
  const { root } = sealRepo();
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(root, 'docs/guide.md') } };
  const first = ctx(hook(root, 'post-tool', edit));
  assert.match(first, /docs\/guide\.md \[consistency\]: has no review yet\./);
  assert.doesNotMatch(first, /out of date/);
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  write(root, 'docs/guide.md', 'Changed.\n');
  assert.match(ctx(hook(root, 'post-tool', edit)), /docs\/guide\.md \[consistency\]: review is now out of date\./);
});

test('findings annotations carry the line number when a finding starts with L<n>', () => {
  const { root } = sealRepo();
  const env = { FAKE_CLAUDE_MODE: 'custom', FAKE_CLAUDE_FINDINGS: JSON.stringify(['L12: wrong date', 'no line here']) };
  assert.equal(run(root, ['review', 'docs/guide.md'], { env }).code, 0);
  const r = run(root, ['check', 'docs/guide.md'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.match(r.out, /^::warning file=docs\/guide\.md,line=12,title=review-seal consistency::L12: wrong date$/m);
  assert.match(r.out, /^::warning file=docs\/guide\.md,title=review-seal consistency::no line here$/m);
});

test('a review whose output has no verdict keeps the raw output in the state directory', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'garbage' } });
  assert.equal(r.code, 1);
  const p = join(root, '.seal/.state/last-reviewer-output.txt');
  assert.ok(existsSync(p));
  assert.match(readFileSync(p, 'utf8'), /I looked and it seems fine\./);
  assert.match(r.err, /could not read a verdict from the reviewer output; raw output saved to \.seal\/\.state\/last-reviewer-output\.txt/);
});

test('a manual review prints each result once', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  assert.equal(r.code, 0);
  const all = r.out + r.err;
  assert.equal(all.match(/L1: says passport here/g).length, 1, all);
  assert.equal(all.match(/findings/g).length, 1, all);
  assert.match(r.err, /reviewing docs\/guide\.md \[consistency\]/);
});
