import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRepo, tmpRepo, run, write } from './helpers.js';

// A cloned repository decides what its own paths are. A symlink committed into it must not let review-seal
// write, read or delete anything outside it.
const outsideDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'review-seal-outside-')));
const listing = (d) => readdirSync(d, { recursive: true }).sort();
const hook = (root, event, payload) => run(root, ['hook', event], { input: JSON.stringify({ session_id: 's1', cwd: root, ...payload }) });
const REFUSED = /goes through a symlink; review-seal refuses to follow it/;

test('a ledger path through a symlink is refused, and nothing is written outside', () => {
  const out = outsideDir();
  writeFileSync(join(out, 'victim.txt'), 'keep me\n');
  const { root } = sealRepo({ ledger: 'out/victim.txt' });
  symlinkSync(out, join(root, 'out'));
  for (const args of [['review', 'docs/guide.md'], ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean'], ['check'], ['list']]) {
    const r = run(root, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, REFUSED, args.join(' '));
  }
  write(root, 'theirs.json', '{}\n');
  assert.equal(run(root, ['merge-ledger', 'theirs.json']).code, 2);
  assert.equal(readFileSync(join(out, 'victim.txt'), 'utf8'), 'keep me\n');
  assert.deepEqual(listing(out), ['victim.txt']);
});

test('a state directory through a symlink: hooks and review --auto write nothing outside', async () => {
  const out = outsideDir();
  mkdirSync(join(out, 'state'));
  writeFileSync(join(out, 'state', 'inbox.jsonl'), JSON.stringify({ file: 'docs/guide.md', pass: 'consistency', findings: ['SECRET-OUTSIDE'] }) + '\n');
  const { root } = sealRepo();
  symlinkSync(join(out, 'state'), join(root, '.seal/.state'));
  const before = listing(out);
  write(root, 'docs/guide.md', 'Visitors need a tax number.\n');
  const post = hook(root, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(root, 'docs/guide.md') } });
  assert.equal(post.code, 0);
  assert.equal(hook(root, 'stop', {}).code, 0);
  const prompt = hook(root, 'user-prompt', {});
  assert.equal(prompt.code, 0);
  assert.doesNotMatch(prompt.out, /SECRET-OUTSIDE/);
  const auto = run(root, ['review', '--auto', '--', 'docs/guide.md']);
  assert.equal(auto.code, 2);
  assert.match(auto.err, REFUSED);
  await new Promise((r) => setTimeout(r, 500)); // anything stop may have started
  assert.deepEqual(listing(out), before);
});

test('a state file that is itself a symlink is neither read nor written', () => {
  const out = outsideDir();
  writeFileSync(join(out, 'secret.jsonl'), JSON.stringify({ file: 'docs/guide.md', pass: 'consistency', findings: ['SECRET-OUTSIDE'] }) + '\n');
  const { root } = sealRepo();
  mkdirSync(join(root, '.seal/.state'), { recursive: true });
  symlinkSync(join(out, 'secret.jsonl'), join(root, '.seal/.state/inbox.jsonl'));
  symlinkSync(join(out, 'log.txt'), join(root, '.seal/.state/review.log'));
  const prompt = hook(root, 'user-prompt', {});
  assert.equal(prompt.code, 0);
  assert.doesNotMatch(prompt.out, /SECRET-OUTSIDE/);
  assert.equal(run(root, ['review', '--auto', '--', 'docs/guide.md']).code, 2);
  assert.deepEqual(listing(out), ['secret.jsonl']);
});

test('a rubric through a symlink is refused, and its text never reaches the session', () => {
  const out = outsideDir();
  writeFileSync(join(out, 'secret.txt'), 'SECRET-OUTSIDE\n');
  const { root } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/secret.txt', files: ['docs/**/*.md'] } } });
  rmSync(join(root, '.seal/rubrics'), { recursive: true });
  symlinkSync(out, join(root, '.seal/rubrics'));
  write(root, 'docs/guide.md', 'Visitors need a tax number.\n');
  const post = hook(root, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(root, 'docs/guide.md') } });
  assert.equal(post.code, 0);
  assert.doesNotMatch(post.out, /SECRET-OUTSIDE/);
  const r = run(root, ['check']);
  assert.equal(r.code, 2);
  assert.match(r.err, /\.seal\/rubrics\/secret\.txt goes through a symlink; review-seal refuses to follow it/);
  assert.deepEqual(listing(out), ['secret.txt']);
});

test('init refuses a .seal directory that is a symlink', () => {
  const out = outsideDir();
  const { root } = tmpRepo();
  symlinkSync(out, join(root, '.seal'));
  const r = run(root, ['init']);
  assert.equal(r.code, 2);
  assert.match(r.err, REFUSED);
  assert.deepEqual(listing(out), []);
});
