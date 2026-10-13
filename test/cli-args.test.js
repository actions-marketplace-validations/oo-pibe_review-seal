import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRepo, tmpRepo, run, write, BIN, cleanEnv } from './helpers.js';

test('paths outside the repository are refused', () => {
  const { root } = sealRepo();
  const outside = join(mkdtempSync(join(tmpdir(), 'review-seal-out-')), 'x.md');
  writeFileSync(outside, 'x\n');
  for (const args of [
    ['seal', outside, '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean'],
    ['seal', '../x.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean'],
    ['review', outside],
    ['review', '..'],
    ['check', outside],
    ['check', '.'],
  ]) {
    const r = run(root, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /is outside the repository/, args.join(' '));
  }
});

test('review of a file that does not exist is a usage error', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'docs/missing.md']);
  assert.equal(r.code, 2);
  assert.match(r.err, /docs\/missing\.md does not exist/);
});

const noStack = (r) => assert.doesNotMatch(r.err, /\n\s+at /);

test('user errors are plain messages, not stack traces', () => {
  const { root } = sealRepo();
  let r = run(root, ['hash', 'nope.md']);
  assert.equal(r.code, 2); assert.match(r.err, /cannot read nope\.md: ENOENT/); noStack(r);
  r = run(root, ['hash', 'docs']);
  assert.equal(r.code, 2); assert.match(r.err, /cannot read docs: EISDIR/); noStack(r);
  r = run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'independent', '--evidence', 'nope.json']);
  assert.equal(r.code, 2); assert.match(r.err, /cannot read nope\.json: ENOENT/); noStack(r);
  for (const cmd of ['check', 'review']) {
    r = run(root, [cmd, '--changed-since', 'no-such-ref']);
    assert.equal(r.code, 2, cmd); assert.match(r.err, /"no-such-ref" is not a valid git ref/); noStack(r);
  }
});

test('unexpected errors print the message only, unless REVIEW_SEAL_DEBUG is set', () => {
  const { root } = sealRepo();
  mkdirSync(join(root, '.seal/ledger.json'));
  let r = run(root, ['list'], { env: { REVIEW_SEAL_DEBUG: '' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /^review-seal: .*EISDIR/);
  noStack(r);
  r = run(root, ['list'], { env: { REVIEW_SEAL_DEBUG: '1' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /\n\s+at /);
});

test('check --staged without a config is a silent no-op; other commands still need one', () => {
  const { root, git } = tmpRepo({ 'a.md': 'a\n' });
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '');
  assert.equal(run(root, ['check']).code, 2);
  assert.equal(run(root, ['list']).code, 2);
});

test('install-hook refuses a hooks directory shared with other repositories unless --force', () => {
  const { root, git } = sealRepo();
  const shared = mkdtempSync(join(tmpdir(), 'review-seal-hooks-'));
  git('config', 'core.hooksPath', shared);
  const r = run(root, ['install-hook']);
  assert.equal(r.code, 2);
  assert.match(r.err, /other repositories/);
  assert.match(r.err, /--force/);
  assert.ok(!existsSync(join(shared, 'pre-commit')));
  assert.equal(run(root, ['install-hook', '--force']).code, 0);
  assert.ok(existsSync(join(shared, 'pre-commit')));
});

test('install-hook accepts a hooks directory inside the work tree', () => {
  const { root, git } = sealRepo();
  git('config', 'core.hooksPath', '.githooks');
  assert.equal(run(root, ['install-hook']).code, 0);
  assert.ok(existsSync(join(root, '.githooks/pre-commit')));
});

test('flags: --key=value works, unknown flags and empty values are usage errors, --help anywhere', () => {
  const { root } = sealRepo();
  assert.equal(run(root, ['seal', 'docs/guide.md', '--pass=consistency', '--reviewer=builder', '--verdict=clean']).code, 0);
  let r = run(root, ['check', '--stagd']);
  assert.equal(r.code, 2); assert.match(r.err, /unknown flag --stagd/);
  r = run(root, ['list', '--all']);
  assert.equal(r.code, 2); assert.match(r.err, /unknown flag --all/);
  r = run(root, ['check', '--staged=yes']);
  assert.equal(r.code, 2); assert.match(r.err, /--staged does not take a value/);
  for (const args of [['check', '--changed-since', ''], ['check', '--changed-since='], ['review', '--changed-since', '']]) {
    r = run(root, args);
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.err, /--changed-since needs a value/);
  }
  for (const args of [['seal', '--help'], ['check', '--staged', '--help'], ['review', 'docs/guide.md', '--help']]) {
    r = run(root, args);
    assert.equal(r.code, 0, args.join(' ')); assert.match(r.out, /^review-seal \d/);
  }
});

test('a clean builder seal cannot carry findings', () => {
  const { root } = sealRepo();
  const r = run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean', '--finding', 'L1: x']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--verdict clean takes no --finding/);
});

test('init recognises an existing .gitignore entry with CRLF line endings', () => {
  const { root } = tmpRepo({ '.gitignore': 'node_modules/\r\n.seal/.state/\r\n' });
  assert.equal(run(root, ['init']).code, 0);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\r\n.seal/.state/\r\n');
});

test('GitHub annotations escape their data and properties', () => {
  const { root, git } = sealRepo();
  write(root, 'docs/a,b:c.md', 'x\n');
  assert.equal(run(root, ['seal', 'docs/a,b:c.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'findings', '--finding', 'L1: 50% off\nnext\rend']).code, 0);
  git('add', '-A');
  const r = run(root, ['check', '--staged'], { env: { GITHUB_ACTIONS: 'true' } });
  // Findings are stored on one line, so line breaks arrive as spaces; % is still escaped.
  assert.match(r.out, /^::warning file=docs\/a%2Cb%3Ac\.md,title=review-seal consistency::L1: 50%25 off next end$/m);
});

test('the pre-commit hook falls back to the node that installed it', () => {
  const { root } = sealRepo();
  run(root, ['install-hook']);
  const hook = readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8');
  const q = (s) => `'${s}'`;
  const fallback = `if [ -x ${q(process.execPath)} ]; then exec ${q(process.execPath)} ${q(BIN)} check --staged; fi`;
  assert.ok(hook.includes(fallback), hook);
  assert.ok(hook.indexOf(fallback) < hook.indexOf('echo'));
  assert.match(hook, /could not find node or review-seal/);
});

test('the pre-commit hook skips env-node launchers when node is not on PATH', (t) => {
  if (spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' } }).status === 0) return t.skip('node is on the minimal PATH');
  const { root, git } = sealRepo();
  run(root, ['install-hook']);
  write(root, 'node_modules/.bin/review-seal', '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(join(root, 'node_modules/.bin/review-seal'), 0o755);
  git('add', 'docs/guide.md', '.seal');
  const r = spawnSync('sh', [join(root, '.git/hooks/pre-commit')], { cwd: root, encoding: 'utf8', env: { ...cleanEnv(), PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /never reviewed/);
});

test('-- ends the options; unknown short flags are usage errors', () => {
  const { root } = sealRepo();
  let r = run(root, ['check', '-s']);
  assert.equal(r.code, 2); assert.match(r.err, /unknown flag -s/);
  r = run(root, ['review', '--', '--x.md']);
  assert.equal(r.code, 2); assert.match(r.err, /--x\.md does not exist/);
  r = run(root, ['review', '--', '--help']);
  assert.equal(r.code, 2); assert.match(r.err, /--help does not exist/);
});
