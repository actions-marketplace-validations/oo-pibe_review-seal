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

test('merge-driver is three-way: a side left as it was at the base takes the other side, whatever the dates', () => {
  const { root } = sealRepo();
  const old = e('docs/x.md', '2026-02-01', { contentHash: H('1') });
  const newer = e('docs/x.md', '2026-02-01', { contentHash: H('2') });
  const older = e('docs/x.md', '2026-01-15', { contentHash: H('3') });
  const base = { 'docs/x.md': { consistency: old } };
  // Ours unchanged since the base: theirs wins on a tie and even when older.
  for (const theirs of [newer, older]) {
    const a = tmp(base);
    assert.equal(run(root, ['merge-driver', tmp(base), a, tmp({ 'docs/x.md': { consistency: theirs } })]).code, 0);
    assert.equal(JSON.parse(readFileSync(a, 'utf8'))['docs/x.md'].consistency.contentHash, theirs.contentHash);
  }
  // Theirs unchanged since the base: ours wins.
  for (const ours of [newer, older]) {
    const a = tmp({ 'docs/x.md': { consistency: ours } });
    assert.equal(run(root, ['merge-driver', tmp(base), a, tmp(base)]).code, 0);
    assert.equal(JSON.parse(readFileSync(a, 'utf8'))['docs/x.md'].consistency.contentHash, ours.contentHash);
  }
  // Both changed: the later review, a tie keeps ours.
  const later = e('docs/x.md', '2026-03-01', { contentHash: H('4') });
  const a = tmp({ 'docs/x.md': { consistency: newer } });
  run(root, ['merge-driver', tmp(base), a, tmp({ 'docs/x.md': { consistency: later } })]);
  assert.equal(JSON.parse(readFileSync(a, 'utf8'))['docs/x.md'].consistency.contentHash, later.contentHash);
  const t = tmp({ 'docs/x.md': { consistency: newer } });
  run(root, ['merge-driver', tmp(base), t, tmp({ 'docs/x.md': { consistency: e('docs/x.md', '2026-02-01', { contentHash: H('5') }) } })]);
  assert.equal(JSON.parse(readFileSync(t, 'utf8'))['docs/x.md'].consistency.contentHash, newer.contentHash);
});

// Same-day reviews on both branches: each branch changed and reviewed a different page.
test('a merge of same-day reviews of different pages keeps each branch\'s review (p1-merge)', () => {
  const { root, git } = sealRepo();
  run(root, ['install-hook']);
  write(root, 'docs/a.md', 'A one.\n'); write(root, 'docs/b.md', 'B one.\n');
  run(root, ['review', 'docs/a.md', 'docs/b.md', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('switch', '-qc', 'feat');
  write(root, 'docs/a.md', 'A two.\n'); run(root, ['review', 'docs/a.md']);
  git('add', '-A'); git('commit', '-qm', 'feat a2');
  git('switch', '-q', 'main');
  write(root, 'docs/b.md', 'B two.\n'); run(root, ['review', 'docs/b.md']);
  git('add', '-A'); git('commit', '-qm', 'main b2');
  git('merge', '-q', '--no-edit', 'feat');
  const c = run(root, ['check']);
  assert.equal(c.code, 0, c.err);
  assert.equal(git('status', '--porcelain').trim(), '');
});

test('a rebase of two same-day reviews of one page keeps the review of the text that lands (rebase-tie)', () => {
  const { root, git } = sealRepo();
  run(root, ['install-hook']);
  write(root, 'docs/x.md', 'x1\n'); write(root, 'docs/y.md', 'y1\n');
  run(root, ['review', 'docs/x.md', 'docs/y.md', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'init');
  git('switch', '-qc', 'topic');
  write(root, 'docs/x.md', 'x2\n'); run(root, ['review', 'docs/x.md']); git('commit', '-qam', 'x2');
  write(root, 'docs/x.md', 'x3\n'); run(root, ['review', 'docs/x.md']); git('commit', '-qam', 'x3');
  git('switch', '-q', 'main');
  write(root, 'docs/y.md', 'y2\n'); run(root, ['review', 'docs/y.md']); git('commit', '-qam', 'main: y2');
  git('switch', '-q', 'topic');
  git('rebase', '-q', 'main');
  const c = run(root, ['check']);
  assert.equal(c.code, 0, c.err);
});

// A ledger entry with a chosen date, for a file's current text, recomputing the token.
function dated(root, file, at) {
  const l = JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));
  const { token, ...fields } = l[file].consistency;
  l[file].consistency = makeEntry(file, 'consistency', { ...fields, at });
  writeFileSync(join(root, '.seal/ledger.json'), serializeLedger(l));
}

test('a merge keeps the merged branch\'s review of the new text over a later renewal of the old text', () => {
  for (const [ours, theirs] of [['2026-10-04', '2026-10-03'], ['2026-10-03', '2026-10-03']]) {
    const { root, git } = sealRepo();
    run(root, ['install-hook']);
    write(root, 'docs/x.md', 'Old text.\n'); run(root, ['review', 'docs/x.md', 'docs/guide.md']); dated(root, 'docs/x.md', '2026-10-01');
    git('add', '-A'); git('commit', '-qm', 'init');
    git('switch', '-qc', 'feat');
    write(root, 'docs/x.md', 'New text.\n'); run(root, ['review', 'docs/x.md']); dated(root, 'docs/x.md', theirs);
    git('add', '-A'); git('commit', '-qm', 'feat');
    const fresh = JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'))['docs/x.md'].consistency;
    git('switch', '-q', 'main');
    // A renewal of the old text on main (review --due), dated later or the same day.
    dated(root, 'docs/x.md', ours);
    git('add', '-A'); git('commit', '-qm', 'renewal');
    // git merge writes its tree before pre-merge-commit runs, so the hook stages the review and stops the merge;
    // git commit finishes it with the review.
    assert.throws(() => git('merge', '-q', '--no-edit', 'feat'), /run git commit to finish the merge/);
    git('commit', '-q', '--no-edit');
    assert.match(git('log', '-1', '--format=%s'), /^Merge branch 'feat'/);
    assert.deepEqual(JSON.parse(git('show', 'HEAD:.seal/ledger.json'))['docs/x.md'].consistency, fresh);
    const c = run(root, ['check']);
    assert.equal(c.code, 0, c.err);
    assert.equal(git('status', '--porcelain').trim(), '');
  }
});
