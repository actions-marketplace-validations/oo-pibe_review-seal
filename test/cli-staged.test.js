import { test } from 'node:test';
import assert from 'node:assert/strict';
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
