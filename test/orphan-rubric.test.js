import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, write, run } from './helpers.js';

const WANT = /review-seal: \.seal\/rubrics\/old\.md is not used by any pass\n/g;

test('list and check warn once about a checklist under .seal/rubrics that no pass uses', () => {
  const { root, git } = sealRepo();
  write(root, '.seal/rubrics/old.md', 'Old checklist.\n');
  write(root, '.seal/rubrics/README.txt.md', 'x\n');
  for (const args of [['list'], ['check'], ['check', 'docs/guide.md']]) {
    const r = run(root, args);
    assert.equal((r.err.match(WANT) || []).length, 1, `${args.join(' ')}: ${r.err}`);
    assert.doesNotMatch(r.err, /consistency\.md is not used/);
  }
  // Not at every commit.
  git('add', '-A');
  assert.doesNotMatch(run(root, ['check', '--staged']).err, WANT);
});

test('no warning when every checklist is used', () => {
  const { root } = sealRepo();
  assert.doesNotMatch(run(root, ['list']).err, /not used by any pass/);
});

test('checklist paths are compared normalised; dotfiles and files that are not .md are ignored', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric: './.seal//rubrics/consistency.md', files: ['docs/**/*.md'] } } });
  write(root, '.seal/rubrics/.DS_Store', 'x');
  write(root, '.seal/rubrics/notes.txt', 'x');
  write(root, '.seal/rubrics/.drafts/old.md', 'x');
  assert.doesNotMatch(run(root, ['list']).err, /not used by any pass/);
});
