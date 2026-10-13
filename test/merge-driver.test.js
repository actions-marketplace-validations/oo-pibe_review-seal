import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEntry, serializeLedger } from '../lib/ledger.js';
import { sealRepo, write, run, FAKE_CLAUDE } from './helpers.js';

// Commits run the installed hooks, which inherit this process's environment.
process.env.REVIEW_SEAL_CLAUDE = FAKE_CLAUDE;

const H = (c) => `sha256:${c.repeat(16)}`;
const e = (file, at, over = {}) => makeEntry(file, 'consistency', { at, contentHash: H('a'), rubricHash: H('b'), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent', ...over });
const tmp = (o) => { const p = join(mkdtempSync(join(tmpdir(), 'rs-md-')), 'f.json'); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); return p; };

test('merge-driver: union per file and pass, later review wins, ties keep ours, invalid entries dropped, deletions kept', () => {
  const { root } = sealRepo();
  const both = e('docs/both.md', '2026-01-01');
  const base = { 'docs/both.md': { consistency: both }, 'docs/pruned.md': { consistency: e('docs/pruned.md', '2026-01-01') } };
  const ours = {
    'docs/both.md': { consistency: e('docs/both.md', '2026-03-01') },
    'docs/tie.md': { consistency: e('docs/tie.md', '2026-02-01', { verdict: 'findings', findings: ['ours'] }) },
    'docs/ours.md': { consistency: e('docs/ours.md', '2026-02-01') },
  };
  const forged = { ...e('docs/bad.md', '2026-09-01'), verdict: 'findings' };
  const theirs = {
    'docs/both.md': { consistency: e('docs/both.md', '2026-04-01') },
    'docs/tie.md': { consistency: e('docs/tie.md', '2026-02-01') },
    'docs/theirs.md': { consistency: e('docs/theirs.md', '2026-02-01') },
    'docs/bad.md': { consistency: forged },
    'docs/pruned.md': { consistency: base['docs/pruned.md'].consistency },
  };
  const a = tmp(ours);
  const r = run(root, ['merge-driver', tmp(base), a, tmp(theirs)]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(a, 'utf8');
  const out = JSON.parse(text);
  assert.equal(text, serializeLedger(out));
  assert.deepEqual(Object.keys(out), ['docs/both.md', 'docs/ours.md', 'docs/theirs.md', 'docs/tie.md']);
  assert.equal(out['docs/both.md'].consistency.at, '2026-04-01');
  assert.deepEqual(out['docs/tie.md'].consistency.findings, ['ours']);
});

test('merge-driver: an unparsable side exits 1 and leaves the file for git to report', () => {
  const { root } = sealRepo();
  const a = tmp('<<<<<<< not json');
  assert.equal(run(root, ['merge-driver', tmp({}), a, tmp({})]).code, 1);
  assert.equal(readFileSync(a, 'utf8'), '<<<<<<< not json');
  assert.equal(run(root, ['merge-driver', tmp(''), tmp({}), tmp('nope')]).code, 1);
  // A missing base (no common ancestor) is an empty file, which is fine.
  assert.equal(run(root, ['merge-driver', tmp(''), tmp({}), tmp({})]).code, 0);
  assert.doesNotMatch(run(root, ['--help']).out, /merge-driver/);
});

// main and feat each review a different new file, so both sides change the ledger at the same place.
function diverged() {
  const r = sealRepo();
  const { root, git } = r;
  const i = run(root, ['install-hook']);
  assert.match(i.out, /merge driver/);
  assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /^\.seal\/ledger\.json merge=review-seal$/m);
  assert.match(git('config', 'merge.review-seal.driver'), /merge-driver %O %A %B/);
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('switch', '-qc', 'feat');
  write(root, 'docs/a.md', 'Page A.\n'); run(root, ['review', 'docs/a.md']);
  git('add', '-A'); git('commit', '-qm', 'feat');
  git('switch', '-q', 'main');
  write(root, 'docs/b.md', 'Page B.\n'); run(root, ['review', 'docs/b.md']);
  git('add', '-A'); git('commit', '-qm', 'main');
  return r;
}
const committed = (git) => Object.keys(JSON.parse(git('show', 'HEAD:.seal/ledger.json'))).sort();

test('a branch merge with diverging ledgers resolves on its own; reviews from both sides survive', () => {
  const { git } = diverged();
  git('merge', '-q', '--no-edit', 'feat');
  assert.deepEqual(committed(git), ['docs/a.md', 'docs/b.md', 'docs/guide.md']);
});

test('a rebase with diverging ledgers resolves on its own; reviews from both sides survive', () => {
  const { git } = diverged();
  git('switch', '-q', 'feat');
  git('rebase', '-q', 'main');
  assert.deepEqual(committed(git), ['docs/a.md', 'docs/b.md', 'docs/guide.md']);
});

test('install-hook does not add the .gitattributes line twice', () => {
  const { root } = sealRepo();
  run(root, ['install-hook']);
  run(root, ['install-hook']);
  assert.equal(readFileSync(join(root, '.gitattributes'), 'utf8').match(/merge=review-seal/g).length, 1);
});
