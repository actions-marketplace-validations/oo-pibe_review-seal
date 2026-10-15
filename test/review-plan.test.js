import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

const twoPasses = () => {
  const r = sealRepo({ passes: {
    consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'] },
    facts: { rubric: '.seal/rubrics/consistency.md', files: ['docs/guide.md'] },
  } });
  write(r.root, 'docs/other.md', 'Other page.\n');
  return r;
};

test('review --all and --due say how much they will review before starting', () => {
  for (const flag of ['--all', '--due']) {
    const { root } = twoPasses();
    const r = run(root, ['review', flag]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^Reviewing 2 files across 2 passes…$/m, flag);
    assert.ok(r.err.indexOf('Reviewing 2 files') < r.err.indexOf('reviewing docs/'), r.err);
  }
});

test('review --all with nothing to do prints no count', () => {
  const { root } = sealRepo();
  run(root, ['review', '--all']);
  const r = run(root, ['review', '--all']);
  assert.doesNotMatch(r.err, /Reviewing/);
  assert.match(r.out, /nothing needs review/);
});

test('one file, one pass: singular', () => {
  const { root } = sealRepo();
  assert.match(run(root, ['review', '--all']).err, /^Reviewing 1 file across 1 pass…$/m);
});

test('review --dry-run lists what would be reviewed, runs no reviewer and exits 0', () => {
  const { root } = twoPasses();
  const log = join(root, 'calls.log');
  for (const args of [['review', '--all', '--dry-run'], ['review', '--due', '--dry-run'], ['review', '--dry-run', 'docs/guide.md']]) {
    const r = run(root, args, { env: { FAKE_CLAUDE_LOG: log } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^would review docs\/guide\.md \[consistency\]$/m, args.join(' '));
    assert.match(r.out, /^would review docs\/guide\.md \[facts\]$/m);
  }
  const all = run(root, ['review', '--all', '--dry-run']);
  assert.match(all.out, /^would review docs\/other\.md \[consistency\]$/m);
  assert.match(all.out, /^2 files across 2 passes$/m);
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(join(root, '.seal/ledger.json')), false);
});

test('review --dry-run with nothing to do says so', () => {
  const { root } = sealRepo();
  run(root, ['review', '--all']);
  const r = run(root, ['review', '--all', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing needs review/);
});
