import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, run, write } from './helpers.js';

test('check --staged judges the staged ledger, and stages reviews that exist but were not staged', () => {
  const { root, git } = sealRepo();
  assert.equal(run(root, ['install-hook']).code, 0);
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'base');
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  git('add', 'docs/guide.md');
  git('commit', '-qm', 'reviewed');
  assert.match(git('show', '--stat', 'HEAD'), /\.seal\/ledger\.json/);
});

test('check --staged blocks when the staged ledger lacks the review and the working one does too', () => {
  const { root, git } = sealRepo();
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /staged \.seal\/ledger\.json/);
});

test('check --staged prints when it stages the ledger', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0);
  assert.match(r.err, /review-seal: staged \.seal\/ledger\.json so this commit carries its reviews/);
  assert.match(git('diff', '--cached', '--name-only'), /\.seal\/ledger\.json/);
});

test('an invalid staged ledger is a ledger error even if the working copy is fine', () => {
  const { root, git } = sealRepo();
  write(root, '.seal/ledger.json', 'not json');
  git('add', '-A');
  write(root, '.seal/ledger.json', '{}\n');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
});

const PARTIAL = /docs\/guide\.md: the staged version differs from your working copy, and reviews run on the working copy\. Stage the whole file \(git add docs\/guide\.md\) or stash the rest, then commit again\./;

test('partially staged file that blocks gets a specific message', () => {
  const { root, git } = sealRepo();
  git('add', 'docs/guide.md');
  write(root, 'docs/guide.md', 'Visitors need a local tax number.\n');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, PARTIAL);
  assert.doesNotMatch(r.err, /Fix: let Claude finish/);
});

test('autoReview "commit" skips partially staged files', () => {
  const { root, git } = sealRepo({ autoReview: 'commit' });
  git('add', 'docs/guide.md');
  write(root, 'docs/guide.md', 'Visitors need a local tax number.\n');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /reviewing docs\/guide\.md/);
  assert.ok(!existsSync(join(root, '.seal/ledger.json')));
  assert.match(r.err, PARTIAL);
});

test('a fully staged file still gets the generic fix line next to a partial one', () => {
  const { root, git } = sealRepo();
  write(root, 'docs/other.md', 'Other.\n');
  git('add', 'docs');
  write(root, 'docs/guide.md', 'Visitors need a local tax number.\n');
  const r = run(root, ['check', '--staged']);
  assert.match(r.err, PARTIAL);
  assert.match(r.err, /review-seal review docs\/other\.md\n/);
});

const ledgerAt = (git, rev) => JSON.parse(git('show', `${rev}:.seal/ledger.json`));

test('path commit (temporary index) carries the review and leaves the real index in step', () => {
  const { root, git } = sealRepo();
  run(root, ['install-hook']);
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'base');
  run(root, ['review', 'docs/guide.md']);
  git('add', 'docs/guide.md');
  git('commit', '-qm', 'x', 'docs/guide.md');
  assert.ok(ledgerAt(git, 'HEAD')['docs/guide.md'].consistency);
  git('diff', '--cached', '--quiet', '--', '.seal/ledger.json'); // throws if the real index differs from HEAD
  write(root, 'src/app.js', 'console.log(2);\n');
  git('add', 'src/app.js');
  git('commit', '-qm', 'unrelated');
  assert.doesNotMatch(git('show', '--stat', 'HEAD'), /ledger\.json/);
});

test('only the committed files\' reviews are staged', () => {
  const { root, git } = sealRepo();
  write(root, 'docs/b.md', 'Another page.\n');
  run(root, ['install-hook']);
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'base');
  run(root, ['review', 'docs/guide.md', 'docs/b.md']);
  git('add', 'docs/guide.md');
  git('commit', '-qm', 'guide only');
  const led = ledgerAt(git, 'HEAD');
  assert.ok(led['docs/guide.md']);
  assert.equal(led['docs/b.md'], undefined);
  assert.ok(JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'))['docs/b.md']);
});

test('git commit -a carries the review', () => {
  const { root, git } = sealRepo();
  run(root, ['install-hook']);
  git('add', '-A'); git('commit', '-qm', 'base', '--no-verify');
  write(root, 'docs/guide.md', 'Visitors need a local tax number.\n');
  run(root, ['review', 'docs/guide.md']);
  git('commit', '-qam', 'all');
  const h = run(root, ['hash', 'docs/guide.md']).out.trim();
  assert.equal(ledgerAt(git, 'HEAD')['docs/guide.md'].consistency.contentHash, h);
  git('diff', '--cached', '--quiet', '--', '.seal/ledger.json');
});
