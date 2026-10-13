import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
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

test('install-hook also guards merges: a clean merge of an unreviewed change is blocked', () => {
  const { root, git } = sealRepo({ substantive: { lines: 8, patterns: ['\\bonly\\b'] } });
  assert.match(run(root, ['install-hook']).out, /pre-merge-commit/);
  assert.ok(statSync(join(root, '.git/hooks/pre-merge-commit')).mode & 0o100);
  write(root, 'docs/guide.md', 'L1 a\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10 a\n');
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'init');
  git('switch', '-qc', 'feat');
  write(root, 'docs/guide.md', 'L1 this is the only gate\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10 a\n');
  git('commit', '-qam', 'feat', '--no-verify');
  git('switch', '-q', 'main');
  write(root, 'src/app.js', 'console.log(2);\n');
  git('commit', '-qam', 'main');
  assert.throws(() => git('merge', '-q', '--no-edit', 'feat'), /BLOCK\s+docs\/guide\.md/);
  assert.throws(() => git('rev-parse', '-q', '--verify', 'HEAD^2')); // no merge commit was made
});

test('install-hook mentions pre-merge-commit to hook managers', () => {
  const b = sealRepo().root;
  mkdirSync(join(b, '.husky'));
  assert.match(run(b, ['install-hook']).out, /pre-merge-commit/);
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

test('install-hook detects every lefthook config name', () => {
  for (const name of ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']) {
    const { root } = sealRepo();
    writeFileSync(join(root, name), 'pre-commit:\n');
    assert.match(run(root, ['install-hook']).out, /lefthook/, name);
    assert.ok(!existsSync(join(root, '.git/hooks/pre-commit')), name);
  }
});

test('help lists install-hook --force', () => {
  const { root } = sealRepo();
  assert.match(run(root, ['--help']).out, /install-hook \[--force\]/);
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

test('review refuses a symlink', () => {
  const { root } = sealRepo();
  symlinkSync('guide.md', join(root, 'docs/link.md'));
  const r = run(root, ['review', 'docs/link.md']);
  assert.equal(r.code, 2);
  assert.match(r.err, /docs\/link\.md is a symlink; review-seal skips symlinks/);
});

test('two stops close together: the second review --auto waits for the first instead of skipping', async () => {
  const { spawn } = await import('node:child_process');
  const { BIN, cleanEnv } = await import('./helpers.js');
  const { root } = sealRepo({ timeoutSeconds: 1 });
  write(root, 'docs/b.md', 'b\n');
  const env = { ...cleanEnv(), REVIEW_SEAL_CLAUDE: FAKE_CLAUDE };
  const slow = spawn(process.execPath, [BIN, 'review', '--auto', '--session=A', '--', 'docs/guide.md'], { cwd: root, env: { ...env, FAKE_CLAUDE_MODE: 'sleep' }, stdio: 'ignore' });
  const done = new Promise((res) => slow.on('exit', res));
  for (let i = 0; i < 100 && !existsSync(join(root, '.seal/.state/review.lock')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(root, '.seal/.state/review.lock')));
  const r = run(root, ['review', '--auto', '--session=B', '--', 'docs/b.md']);
  await done;
  assert.equal(r.code, 0);
  const log = readFileSync(join(root, '.seal/.state/review.log'), 'utf8');
  assert.doesNotMatch(log, /skipping/);
  assert.match(run(root, ['list']).out, /docs\/b\.md\n\s+consistency\s+fresh/);
});

test('a manual review that finds the lock held names the command to retry', () => {
  const { root } = sealRepo();
  mkdirSync(join(root, '.seal/.state'), { recursive: true });
  writeFileSync(join(root, '.seal/.state/review.lock'), JSON.stringify({ pid: process.pid, nonce: 'x' }));
  const r = run(root, ['review', 'docs/guide.md']);
  assert.equal(r.code, 1);
  assert.match(r.err, /another review is already running; run review-seal review docs\/guide\.md when it finishes/);
});
