import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo, sealRepo, write, run } from './helpers.js';

test('init creates config, rubric, ledger and gitignore; refuses to overwrite', () => {
  const { root } = tmpRepo();
  assert.equal(run(root, ['init']).code, 0);
  for (const f of ['.seal/config.json', '.seal/rubrics/review.md', '.seal/ledger.json']) assert.ok(existsSync(join(root, f)), f);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.seal\/\.state\/$/m);
  const again = run(root, ['init']);
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists/);
});

test('hash prints the normalised content hash', () => {
  const { root } = sealRepo();
  assert.match(run(root, ['hash', 'docs/guide.md']).out, /^sha256:[0-9a-f]{16}\n$/);
});

test('check --staged: blocks an unreviewed covered file, ignores uncovered ones', () => {
  const { root, git } = sealRepo();
  git('add', 'src/app.js', '.seal');
  assert.equal(run(root, ['check', '--staged']).code, 0);
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCK\s+docs\/guide\.md \[consistency\] never reviewed/);
  assert.match(r.err, /review-seal review docs\/guide\.md/);
});

test('review then check passes; edit after review blocks again', () => {
  const { root, git } = sealRepo();
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  git('add', '-A');
  assert.equal(run(root, ['check', '--staged']).code, 0);
  git('commit', '-qm', 'reviewed');
  write(root, 'docs/guide.md', 'Visitors need a local tax number.\n');
  git('add', 'docs/guide.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /then the file changed/);
});

test('whitespace-only edit keeps the seal', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'r');
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.   \r\n\n');
  git('add', '-A');
  assert.equal(run(root, ['check', '--staged']).code, 0);
});

test('editing the rubric blocks', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'r');
  write(root, '.seal/rubrics/consistency.md', 'A stricter checklist.\n');
  // whitespace-only edit: stages the file without changing its content hash
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.   \n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /older version of the consistency checklist/);
});

test('hand-edited ledger blocks', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  const p = join(root, '.seal/ledger.json');
  const led = JSON.parse(readFileSync(p, 'utf8'));
  led['docs/guide.md'].consistency.verdict = 'clean';
  led['docs/guide.md'].consistency.findings = [];
  write(root, '.seal/ledger.json', JSON.stringify(led));
  git('add', '-A');
  assert.match(run(root, ['check', '--staged']).err, /token mismatch/);
});

test('trivial edit with patterns configured only warns', () => {
  const { root, git } = sealRepo({ substantive: { patterns: ['\\bonly\\b'] } });
  git('add', '-A'); git('commit', '-qm', 'init');
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport. Bring a jacket.\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0);
  assert.match(r.err, /WARN/);
});

test('open findings are flagged at save time but do not block', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0);
  assert.match(r.err, /FLAG\s+docs\/guide\.md \[consistency\] open finding/);
  const gh = run(root, ['check', '--staged'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.match(gh.out, /^::warning file=docs\/guide\.md,title=review-seal consistency::L1:/m);
});

test('list shows status and counts', () => {
  const { root } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  const r = run(root, ['list']);
  assert.match(r.out, /docs\/guide\.md\n\s+consistency\s+fresh/);
  assert.match(r.out, /1 independent, 0 builder/);
});

test('no config: plain error, exit 2', () => {
  const { root } = tmpRepo();
  const r = run(root, ['check']);
  assert.equal(r.code, 2);
  assert.match(r.err, /run "review-seal init" first/);
});
