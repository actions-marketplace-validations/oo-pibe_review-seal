import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo, write, run } from './helpers.js';

test('init from a subdirectory says which repository root it wrote to, and to commit .seal/', () => {
  const { root } = tmpRepo();
  write(root, 'packages/site/readme.md', 'x\n');
  const r = run(root, ['init'], { cwd: join(root, 'packages/site') });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(root, '.seal/config.json')));
  assert.ok(r.out.includes(`in ${root}`), r.out);
  assert.match(r.out, /Commit \.seal\/ \(the ledger is your review history\)/);
});

test('init keeps a CRLF .gitignore in CRLF', () => {
  const { root } = tmpRepo({ '.gitignore': 'node_modules/\r\ndist/\r\n' });
  assert.equal(run(root, ['init']).code, 0);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\r\ndist/\r\n.seal/.state/\r\n');
  const b = tmpRepo({ '.gitignore': 'node_modules/\r\ndist/' });
  assert.equal(run(b.root, ['init']).code, 0);
  assert.equal(readFileSync(join(b.root, '.gitignore'), 'utf8'), 'node_modules/\r\ndist/\r\n.seal/.state/\r\n');
  const c = tmpRepo({ '.gitignore': 'node_modules/\n' });
  assert.equal(run(c.root, ['init']).code, 0);
  assert.equal(readFileSync(join(c.root, '.gitignore'), 'utf8'), 'node_modules/\n.seal/.state/\n');
});
