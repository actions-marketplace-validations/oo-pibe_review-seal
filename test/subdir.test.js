import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { sealRepo, write, run } from './helpers.js';

// A PATH with node and git but no review-seal.
const PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');

test('Fix hints name paths from the current directory', () => {
  const { root } = sealRepo();
  const r = run(root, ['check', 'guide.md'], { cwd: join(root, 'docs'), env: { PATH } });
  assert.equal(r.code, 1);
  assert.match(r.err, /^ {7}review-seal review guide\.md$/m);
});

test('Fix hints say npx review-seal when only node_modules/.bin has it', () => {
  const { root } = sealRepo();
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.bin/review-seal'), '#!/bin/sh\n');
  chmodSync(join(root, 'node_modules/.bin/review-seal'), 0o755);
  const r = run(root, ['check', 'guide.md'], { cwd: join(root, 'docs'), env: { PATH } });
  assert.match(r.err, /^ {7}npx review-seal review guide\.md$/m);
  const top = run(root, ['check', 'docs/guide.md'], { env: { PATH } });
  assert.match(top.err, /^ {7}npx review-seal review docs\/guide\.md$/m);
  // On PATH, the bare name.
  const bin = join(root, 'bin-on-path');
  mkdirSync(bin);
  writeFileSync(join(bin, 'review-seal'), '#!/bin/sh\n');
  chmodSync(join(bin, 'review-seal'), 0o755);
  assert.match(run(root, ['check', 'docs/guide.md'], { env: { PATH: `${bin}:${PATH}` } }).err, /^ {7}review-seal review docs\/guide\.md$/m);
});

test('review takes a path from the repository root when it does not exist from the current directory', () => {
  const { root } = sealRepo();
  write(root, 'src/docs/other.txt', 'x\n');
  const r = run(root, ['review', 'docs/guide.md'], { cwd: join(root, 'src') });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /docs\/guide\.md \[consistency\] clean/);
  const missing = run(root, ['review', 'docs/nope.md'], { cwd: join(root, 'src') });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /docs\/nope\.md does not exist/);
});
