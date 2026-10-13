import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

const FORMATTER = /reviewed version differs from the staged version only in whitespace \(a formatter may have changed it after the review; run your formatter before reviewing, and run review-seal last in your hooks\)/;

test('a file a formatter changed after its review says the reviewed version differs', () => {
  const { root, git } = sealRepo();
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'base');
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.\n\n\nThey   can.\n');
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  // The formatter rewrites the file and stages it, after the review.
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.\n\nThey can.\n');
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCK\s+docs\/guide\.md/);
  assert.match(r.err, FORMATTER);
});

test('a file never reviewed gets no formatter note', () => {
  const { root, git } = sealRepo();
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, FORMATTER);
});

test('install-hook tells husky and lefthook users to run review-seal last', () => {
  const a = sealRepo();
  mkdirSync(join(a.root, '.husky'));
  assert.match(run(a.root, ['install-hook']).out, /husky: add "review-seal check --staged" as the last line of \.husky\/pre-commit and \.husky\/pre-merge-commit, after any formatter/);
  const b = sealRepo();
  write(b.root, 'lefthook.yml', 'pre-commit:\n');
  assert.match(run(b.root, ['install-hook']).out, /lefthook: .*after any formatter/);
});

test('a review of another version names its date, never "never reviewed"', () => {
  const { root, git } = sealRepo();
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'base');
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.\n\n\nThey   can.\n');
  run(root, ['review', 'docs/guide.md']);
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.\n\nThey can.\n');
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.match(r.err, /BLOCK {2}docs\/guide\.md \[consistency\] reviewed \d{4}-\d{2}-\d{2}, then the file changed/);
  assert.doesNotMatch(r.err, /never reviewed/);
});

test('an edit to the words after the review gets no formatter note', () => {
  const { root, git } = sealRepo();
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'base');
  run(root, ['review', 'docs/guide.md']);
  write(root, 'docs/guide.md', 'Visitors can buy tickets with an ID card.\n');
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCK {2}docs\/guide\.md \[consistency\] reviewed \d{4}-\d{2}-\d{2}, then the file changed/);
  assert.doesNotMatch(r.err, /formatter/);
  assert.doesNotMatch(r.err, /never reviewed/);
});
