import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write, run, FAKE_CLAUDE } from './helpers.js';

// `git commit` runs the installed pre-commit hook, which inherits this process's environment.
process.env.REVIEW_SEAL_CLAUDE = FAKE_CLAUDE;

test('review prints findings; failures exit 1 and write nothing', () => {
  const { root } = sealRepo();
  const f = run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  assert.equal(f.code, 0);
  assert.match(f.out, /docs\/guide\.md \[consistency\] findings\n\s+L1:/);
  write(root, 'docs/guide.md', 'changed\n');
  const g = run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'garbage' } });
  assert.equal(g.code, 1);
  assert.match(run(root, ['list']).out, /STALE/);
});

test('review reports nothing to do on a fresh file', () => {
  const { root } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  assert.match(run(root, ['review', 'docs/guide.md']).out, /nothing needs review/);
});

test('review with no target is a usage error', () => {
  const { root } = sealRepo();
  assert.equal(run(root, ['review']).code, 2);
});

test('review --auto logs to the state dir and prints nothing', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', '--auto', 'docs/guide.md']);
  assert.equal(r.out, '');
  assert.match(readFileSync(join(root, '.seal/.state/review.log'), 'utf8'), /reviewing docs\/guide\.md/);
});

test('install-hook writes an executable pre-commit that blocks, then passes after review', () => {
  const { root, git } = sealRepo();
  assert.equal(run(root, ['install-hook']).code, 0);
  const hook = join(root, '.git/hooks/pre-commit');
  assert.ok(statSync(hook).mode & 0o100);
  git('add', '-A');
  assert.throws(() => git('commit', '-qm', 'unreviewed'), /never reviewed/);
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A');
  git('commit', '-qm', 'reviewed');
});

test('install-hook leaves foreign hooks and hook managers alone', () => {
  const { root } = sealRepo();
  mkdirSync(join(root, '.git/hooks'), { recursive: true });
  writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\necho mine\n');
  assert.match(run(root, ['install-hook']).out, /already exists/);
  assert.equal(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
  const b = sealRepo().root;
  mkdirSync(join(b, '.husky'));
  assert.match(run(b, ['install-hook']).out, /husky/);
  assert.ok(!existsSync(join(b, '.git/hooks/pre-commit')));
});

test('autoReview "commit" reviews and stages the ledger inside the hook', () => {
  const { root, git } = sealRepo({ autoReview: 'commit' });
  run(root, ['install-hook']);
  git('add', '-A');
  git('commit', '-qm', 'auto-reviewed');
  assert.match(git('show', '--stat', 'HEAD'), /\.seal\/ledger\.json/);
});

test('review --auto --session tags what it leaves in the inbox', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', '--auto', '--session', 'abc', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'fail' } });
  assert.equal(r.code, 1);
  const items = readFileSync(join(root, '.seal/.state/inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(items.map((i) => i.session), ['abc']);
});
