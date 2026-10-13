import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, renameSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRepo, run, write } from './helpers.js';

const ledger = (root) => JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));
const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('a renamed file reuses its review instead of paying for a new one', () => {
  const { root, git } = sealRepo();
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls');
  assert.equal(run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_LOG: log } }).code, 0);
  assert.equal(calls(log), 1);
  const old = ledger(root)['docs/guide.md'].consistency;
  git('add', '-A'); git('commit', '-qm', 'base');
  git('mv', 'docs/guide.md', 'docs/visitors.md');
  const r = run(root, ['review', 'docs/visitors.md'], { env: { FAKE_CLAUDE_LOG: log } });
  assert.equal(r.code, 0, r.err);
  assert.equal(calls(log), 1);
  assert.match(r.out, /docs\/visitors\.md \[consistency\] clean \(the review of docs\/guide\.md, same text\)/);
  const led = ledger(root);
  assert.equal(led['docs/guide.md'], undefined);
  const e = led['docs/visitors.md'].consistency;
  for (const k of ['at', 'contentHash', 'rubricHash', 'verdict', 'reviewer', 'via', 'reviewedBlob']) assert.equal(e[k], old[k], k);
  assert.equal(run(root, ['check', 'docs/visitors.md']).code, 0);
});

test('a review is not reused while its file still exists, or for different text', () => {
  const { root, git } = sealRepo();
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls');
  run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_LOG: log } });
  write(root, 'docs/copy.md', readFileSync(join(root, 'docs/guide.md'), 'utf8'));
  run(root, ['review', 'docs/copy.md'], { env: { FAKE_CLAUDE_LOG: log } });
  assert.equal(calls(log), 2);
  assert.ok(ledger(root)['docs/guide.md']);
  renameSync(join(root, 'docs/guide.md'), join(root, 'docs/moved.md'));
  write(root, 'docs/moved.md', 'Different text.\n');
  run(root, ['review', 'docs/moved.md'], { env: { FAKE_CLAUDE_LOG: log } });
  assert.equal(calls(log), 3);
});

test('prune removes entries for files that are gone or no longer covered, and says which', () => {
  const { root } = sealRepo();
  write(root, 'docs/gone.md', 'Gone soon.\n');
  write(root, 'docs/out.md', 'Moves out of coverage.\n');
  run(root, ['review', 'docs/guide.md', 'docs/gone.md', 'docs/out.md']);
  renameSync(join(root, 'docs/gone.md'), join(root, 'notes-gone.txt'));
  renameSync(join(root, 'docs/out.md'), join(root, 'out.md'));
  write(root, 'docs/out.md', 'x\n');
  write(root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/guide.md'] } } }));
  const r = run(root, ['prune']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /removed docs\/gone\.md \[consistency\]: no longer exists/);
  assert.match(r.out, /removed docs\/out\.md \[consistency\]: no longer covered/);
  assert.deepEqual(Object.keys(ledger(root)), ['docs/guide.md']);
  assert.match(run(root, ['prune']).out, /nothing to prune/);
  assert.match(run(root, ['--help']).out, /review-seal prune/);
});
