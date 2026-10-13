import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

const evidence = (root, over = {}) => {
  const ch = run(root, ['hash', 'docs/guide.md']).out.trim();
  const rh = run(root, ['hash', '.seal/rubrics/consistency.md']).out.trim();
  write(root, 'ev.json', JSON.stringify({ file: 'docs/guide.md', pass: 'consistency', contentHash: ch, rubricHash: rh, verdict: 'clean', findings: [], ...over }));
};

test('builder seal is recorded as builder/manual', () => {
  const { root } = sealRepo();
  assert.equal(run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean']).code, 0);
  const e = JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'))['docs/guide.md'].consistency;
  assert.equal(e.reviewer, 'builder');
  assert.equal(e.via, 'manual');
});

test('builder seal blocks from independentFrom onward', () => {
  const { root, git } = sealRepo({ independentFrom: '2026-01-01' });
  run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean']);
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /only an independent review counts/);
});

test('independent seal needs evidence for this exact version', () => {
  const { root } = sealRepo();
  assert.equal(run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'independent']).code, 2);
  evidence(root, { contentHash: 'sha256:0000000000000000' });
  const r = run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'independent', '--evidence', 'ev.json']);
  assert.equal(r.code, 3);
  assert.match(r.err, /different version/);
  evidence(root, { pass: 'other' });
  assert.match(run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'independent', '--evidence', 'ev.json']).err, /evidence is for/);
  evidence(root);
  assert.equal(run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'independent', '--evidence', 'ev.json']).code, 0);
});

test('bad seal invocations are usage errors', () => {
  const { root } = sealRepo();
  const s = (...x) => run(root, ['seal', 'docs/guide.md', ...x]);
  assert.match(s('--pass', 'nope', '--reviewer', 'builder', '--verdict', 'clean').err, /no pass named "nope"/);
  assert.match(s('--pass', 'consistency', '--reviewer', 'me', '--verdict', 'clean').err, /--reviewer must be/);
  assert.match(s('--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'findings').err, /at least one --finding/);
  assert.match(run(root, ['seal', 'src/app.js', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean']).err, /its passes: none/);
});

test('seal refuses a symlink', () => {
  const { root } = sealRepo();
  symlinkSync('guide.md', join(root, 'docs/link.md'));
  const r = run(root, ['seal', 'docs/link.md', '--pass', 'consistency', '--reviewer', 'builder']);
  assert.equal(r.code, 2);
  assert.match(r.err, /docs\/link\.md is a symlink; review-seal skips symlinks/);
});
