import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRepo, tmpRepo, run } from './helpers.js';

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
