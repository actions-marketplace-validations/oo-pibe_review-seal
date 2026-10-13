import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // A checklist change goes in on its own (settings never travel with content).
  git('add', '-A');
  assert.equal(run(root, ['check', '--staged']).code, 0);
  git('commit', '-qm', 'stricter');
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
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  git('add', '-A'); git('commit', '-qm', 'init');
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport. Bring a jacket.\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0);
  assert.match(r.err, /WARN/);
});

test('a new covered file with a trivial change and no review blocks (never reviewed is never soft)', () => {
  const { root, git } = sealRepo({ substantive: { lines: 8, patterns: ['\\bonly\\b'] } });
  git('add', '.seal', 'src/app.js'); git('commit', '-qm', 'init');
  write(root, 'docs/new.md', '# Note\n\nVisitors must bring a printed ticket.\n');
  git('add', 'docs/new.md');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCK\s+docs\/new\.md \[consistency\] never reviewed/);
  assert.doesNotMatch(r.err, /WARN/);
});

test('open findings are flagged at save time but do not block', () => {
  const { root, git } = sealRepo();
  run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0);
  assert.match(r.err, /FLAG\s+docs\/guide\.md \[consistency\] open finding/);
  const gh = run(root, ['check', '--staged'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.match(gh.out, /^::warning file=docs\/guide\.md,line=1,title=review-seal consistency::L1:/m);
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

test('ledger-path prints the configured ledger path; exit 2 without a config', () => {
  assert.equal(run(sealRepo().root, ['ledger-path']).out, '.seal/ledger.json\n');
  const custom = run(sealRepo({ ledger: 'audit/seals.json' }).root, ['ledger-path']);
  assert.equal(custom.code, 0);
  assert.equal(custom.out, 'audit/seals.json\n');
  const none = run(tmpRepo().root, ['ledger-path']);
  assert.equal(none.code, 2);
  assert.match(none.err, /run "review-seal init" first/);
  assert.equal(run(sealRepo().root, ['ledger-path', '--staged']).code, 2);
});

test('explicit check skips a covered symlink', () => {
  const { root } = sealRepo();
  symlinkSync('guide.md', join(root, 'docs/link.md'));
  run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder']);
  const r = run(root, ['check', 'docs/link.md']);
  assert.equal(r.code, 0);
  assert.match(r.err, /skipping docs\/link\.md: review-seal skips symlinks/);
});

test('a Latin-1 file whose bytes change needs a new review', () => {
  const { root } = sealRepo();
  writeFileSync(join(root, 'docs/latin.md'), Buffer.from('Caf\xe9 opens at noon.\n', 'latin1'));
  assert.equal(run(root, ['review', 'docs/latin.md']).code, 0);
  assert.equal(run(root, ['check', 'docs/latin.md']).code, 0);
  const before = run(root, ['hash', 'docs/latin.md']).out;
  writeFileSync(join(root, 'docs/latin.md'), Buffer.from('Caf\xe8 opens at noon.\n', 'latin1'));
  assert.notEqual(run(root, ['hash', 'docs/latin.md']).out, before);
  const r = run(root, ['check', 'docs/latin.md']);
  assert.equal(r.code, 1);
  assert.match(r.err, /docs\/latin\.md/);
});

test('check outside a commit does not talk about a commit', () => {
  const { root, git } = sealRepo();
  const r = run(root, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /these files need a fresh independent review:\n/);
  assert.doesNotMatch(r.err, /before this commit/);
  git('add', 'docs/guide.md');
  assert.match(run(root, ['check', '--staged']).err, /these files need a fresh independent review before this commit:\n/);
});
