import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRepo, run } from './helpers.js';

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
