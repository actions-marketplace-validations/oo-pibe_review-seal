import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, write, run, CONFIG } from './helpers.js';
import { narrowing } from '../lib/narrow.js';

const RUBRIC = '.seal/rubrics/consistency.md';
const TWO = { passes: { consistency: { rubric: RUBRIC, files: ['docs/**/*.md'] }, facts: { rubric: '.seal/rubrics/facts.md', files: ['docs/**/*.md'] } } };
const cfgOf = (o) => ({ ledger: '.seal/ledger.json', ...o });
const NARROWS = /BLOCK {2}\.seal\/config\.json this change narrows review coverage \((.*)\); commit the config change on its own after review, or get it reviewed/;

test('narrowing: names each way a config narrows coverage, and nothing for a wider one', () => {
  const base = cfgOf(TWO);
  const files = ['docs/guide.md', 'docs/a/b.md', 'src/x.js', '.seal/config.json'];
  assert.deepEqual(narrowing(base, cfgOf(TWO), files), []);
  assert.deepEqual(narrowing(base, cfgOf({ passes: { ...TWO.passes, more: { rubric: RUBRIC, files: ['**'] } } }), files), []);
  assert.deepEqual(narrowing(base, cfgOf({ passes: { consistency: TWO.passes.consistency } }), files), ['drops the "facts" pass']);
  assert.deepEqual(narrowing(base, cfgOf({ passes: { ...TWO.passes, consistency: { rubric: RUBRIC, files: ['docs/a/**'] } } }), files), ['docs/guide.md is no longer covered by "consistency"']);
  assert.deepEqual(narrowing(base, cfgOf({ ...TWO, ledger: 'other.json' }), files), ['moves the ledger from .seal/ledger.json to other.json']);
  assert.deepEqual(narrowing(base, cfgOf({ passes: { ...TWO.passes, facts: { rubric: '.seal/rubrics/f2.md', files: ['docs/**/*.md'] } } }), files), ['changes the "facts" checklist from .seal/rubrics/facts.md to .seal/rubrics/f2.md']);
  assert.deepEqual(narrowing(base, null, files), ['removes .seal/config.json']);
  // The config file itself is never a covered file.
  const all = cfgOf({ passes: { consistency: { rubric: RUBRIC, files: ['**'] } } });
  assert.deepEqual(narrowing(all, cfgOf({ passes: { consistency: { rubric: RUBRIC, files: ['docs/**', 'src/**'] } } }), files), []);
  const many = Array.from({ length: 8 }, (_, i) => `docs/f${i}.md`);
  const d = narrowing(base, cfgOf({ passes: { ...TWO.passes, consistency: { rubric: RUBRIC, files: ['none/**'] } } }), many);
  assert.equal(d.length, 1);
  assert.match(d[0], /^docs\/f0\.md, docs\/f1\.md, docs\/f2\.md, docs\/f3\.md, docs\/f4\.md and 3 more are no longer covered by "consistency"$/);
});

// A committed base: config with two passes, both checklists, a reviewed guide.
function base() {
  const r = sealRepo(TWO);
  write(r.root, '.seal/rubrics/facts.md', 'Are the facts right?\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'base');
  return r;
}
const staged = (r) => run(r.root, ['check', '--staged']);

test('check --staged blocks a change that drops a pass along with a covered file', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { consistency: TWO.passes.consistency } }));
  run(r.root, ['review', 'docs/guide.md']);
  write(r.root, 'docs/guide.md', 'Changed.\n'); run(r.root, ['review', 'docs/guide.md']);
  r.git('add', '-A');
  const c = staged(r);
  assert.equal(c.code, 1);
  assert.match(c.err, NARROWS);
  assert.match(c.err.match(NARROWS)[1], /drops the "facts" pass/);
});

test('check --staged blocks narrowing a glob, for files at base and files new in the change', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { ...TWO.passes, consistency: { rubric: RUBRIC, files: ['docs/kept/**'] } } }));
  write(r.root, 'docs/new.md', 'New.\n');
  write(r.root, 'src/app.js', 'console.log(2);\n');
  r.git('add', '-A');
  const c = staged(r);
  assert.equal(c.code, 1);
  assert.match(c.err.match(NARROWS)[1], /docs\/guide\.md, docs\/new\.md are no longer covered by "consistency"/);
});

test('check --staged blocks moving the ledger and renaming a checklist', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ ...TWO, ledger: 'elsewhere/ledger.json' }));
  write(r.root, 'src/app.js', 'console.log(2);\n');
  r.git('add', '-A');
  assert.match(staged(r).err.match(NARROWS)[1], /moves the ledger from \.seal\/ledger\.json to elsewhere\/ledger\.json/);

  const s = base();
  write(s.root, '.seal/rubrics/other.md', 'Lax.\n');
  write(s.root, '.seal/config.json', JSON.stringify({ passes: { ...TWO.passes, consistency: { rubric: '.seal/rubrics/other.md', files: ['docs/**/*.md'] } } }));
  write(s.root, 'src/app.js', 'console.log(2);\n');
  s.git('add', '-A');
  assert.match(staged(s).err.match(NARROWS)[1], /changes the "consistency" checklist from \.seal\/rubrics\/consistency\.md to \.seal\/rubrics\/other\.md/);
});

test('check --staged blocks taking the config out of the index with other changes', () => {
  const r = base();
  r.git('rm', '-q', '--cached', '.seal/config.json');
  write(r.root, 'docs/guide.md', 'Changed.\n');
  r.git('add', 'docs/guide.md');
  const c = staged(r);
  assert.equal(c.code, 1);
  assert.match(c.err.match(NARROWS)[1], /removes \.seal\/config\.json/);
});

test('a config-only change may narrow coverage: the escape for a separate, reviewed commit', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: RUBRIC, files: ['docs/kept/**'] } }, ledger: '.seal/l2.json' }));
  r.git('add', '-A');
  const c = staged(r);
  assert.equal(c.code, 0, c.err);
  assert.doesNotMatch(c.err, /narrows/);
  r.git('commit', '-qm', 'config only');
  // Removing review-seal altogether is a config-only change too.
  r.git('rm', '-q', '.seal/config.json');
  assert.equal(staged(r).code, 0);
});

test('widening coverage, or a first config, is not blocked', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { ...TWO.passes, more: { rubric: RUBRIC, files: ['src/**'] } } }));
  write(r.root, 'src/app.js', 'console.log(2);\n');
  run(r.root, ['review', 'src/app.js']);
  r.git('add', '-A');
  const c = staged(r);
  assert.doesNotMatch(c.err, /narrows/);

  const f = sealRepo();
  f.git('add', '-A');
  assert.doesNotMatch(staged(f).err, /narrows/);
});

test('check --changed-since compares with the merge base config', () => {
  const r = base();
  r.git('checkout', '-qb', 'pr');
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: RUBRIC, files: ['nothing/**'] } } }));
  r.git('commit', '-qam', 'narrow');
  // A config-only branch passes.
  const ok = run(r.root, ['check', '--changed-since', 'main']);
  assert.equal(ok.code, 0, ok.err);
  // A later commit on the same branch is judged with the config change: the branch as a whole narrows coverage.
  write(r.root, 'docs/guide.md', 'Unreviewed claim.\n');
  r.git('commit', '-qam', 'content');
  const c = run(r.root, ['check', '--changed-since', 'main']);
  assert.equal(c.code, 1);
  const d = c.err.match(NARROWS)[1];
  assert.match(d, /drops the "facts" pass/);
  assert.match(d, /docs\/guide\.md is no longer covered by "consistency"/);
});
