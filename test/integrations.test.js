import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sealRepo, write, run, FAKE_CLAUDE } from './helpers.js';

test('review/check --changed-since behave as the Action uses them', () => {
  const { root, git } = sealRepo();
  git('add', '-A'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write(root, 'docs/guide.md', 'A changed claim.\n');
  git('commit', '-qam', 'change');
  assert.equal(run(root, ['check', '--changed-since', 'origin/main']).code, 1);
  assert.equal(run(root, ['review', '--changed-since', 'origin/main'], { env: { REVIEW_SEAL_CLAUDE: FAKE_CLAUDE } }).code, 0);
  assert.equal(run(root, ['check', '--changed-since', 'origin/main']).code, 0);
});

test('pre-commit manifest points at check --staged', () => {
  const y = readFileSync(new URL('../.pre-commit-hooks.yaml', import.meta.url), 'utf8');
  assert.match(y, /entry: review-seal check --staged/);
  assert.match(y, /language: node/);
});

test('action passes inputs through env only', () => {
  const y = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  for (const line of y.split('\n').filter((l) => /^\s+run:/.test(l))) assert.doesNotMatch(line, /\$\{\{/);
});
