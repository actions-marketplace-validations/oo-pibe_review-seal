import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, write, run } from './helpers.js';

const RUBRIC = '.seal/rubrics/consistency.md';
const TWO = { passes: { consistency: { rubric: RUBRIC, files: ['docs/**/*.md'] }, facts: { rubric: '.seal/rubrics/facts.md', files: ['docs/**/*.md'] } } };
const SETTINGS = /BLOCK {2}this change edits review settings \((.*)\) together with content; commit the settings change on its own/;

// A committed base: config with two passes, both checklists, a reviewed guide.
function base(over = {}) {
  const r = sealRepo({ ...TWO, ...over });
  write(r.root, '.seal/rubrics/facts.md', 'Are the facts right?\n');
  run(r.root, ['review', 'docs/guide.md']);
  r.git('add', '-A'); r.git('commit', '-qm', 'base');
  return r;
}
const staged = (r) => run(r.root, ['check', '--staged']);
const blocked = (r) => {
  const c = staged(r);
  assert.equal(c.code, 1, c.err);
  const m = c.err.match(SETTINGS);
  assert.ok(m, c.err);
  return m[1];
};

test('check --staged blocks a change that drops a pass along with a covered file', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { consistency: TWO.passes.consistency } }));
  write(r.root, 'docs/guide.md', 'Changed.\n'); run(r.root, ['review', 'docs/guide.md']);
  r.git('add', '-A');
  assert.equal(blocked(r), '.seal/config.json');
});

test('check --staged blocks narrowing a glob, for files at base and files new in the change', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { ...TWO.passes, consistency: { rubric: RUBRIC, files: ['docs/kept/**'] } } }));
  write(r.root, 'docs/new.md', 'New.\n');
  write(r.root, 'src/app.js', 'console.log(2);\n');
  r.git('add', '-A');
  assert.equal(blocked(r), '.seal/config.json');
});

test('check --staged blocks moving the ledger and renaming a checklist', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ ...TWO, ledger: 'elsewhere/ledger.json' }));
  write(r.root, 'src/app.js', 'console.log(2);\n');
  r.git('add', '-A');
  assert.equal(blocked(r), '.seal/config.json');

  const s = base();
  write(s.root, '.seal/rubrics/other.md', 'Lax.\n');
  write(s.root, '.seal/config.json', JSON.stringify({ passes: { ...TWO.passes, consistency: { rubric: '.seal/rubrics/other.md', files: ['docs/**/*.md'] } } }));
  write(s.root, 'src/app.js', 'console.log(2);\n');
  s.git('add', '-A');
  assert.equal(blocked(s), '.seal/config.json, .seal/rubrics/other.md');
});

test('check --staged blocks taking the config out of the index with other changes', () => {
  const r = base();
  r.git('rm', '-q', '--cached', '.seal/config.json');
  write(r.root, 'docs/guide.md', 'Changed.\n');
  r.git('add', 'docs/guide.md');
  assert.equal(blocked(r), '.seal/config.json');
});

test('check --staged blocks loosening settings that do not touch coverage, along with content', () => {
  const cases = [
    [{ blockOnFindings: true }, { blockOnFindings: false }],
    [{ passes: { ...TWO.passes, facts: { ...TWO.passes.facts, maxAgeDays: 30 } } }, { passes: { ...TWO.passes, facts: { ...TWO.passes.facts, maxAgeDays: 3650 } } }],
    [{ independentFrom: '2026-01-01' }, {}],
  ];
  for (const [from, to] of cases) {
    const r = base(from);
    write(r.root, '.seal/config.json', JSON.stringify({ ...TWO, ...to }));
    write(r.root, 'src/app.js', 'console.log(2);\n');
    r.git('add', '-A');
    assert.equal(blocked(r), '.seal/config.json', JSON.stringify(to));
  }
});

test('check --staged blocks a checklist edit committed with content', () => {
  const r = base();
  write(r.root, '.seal/rubrics/facts.md', 'Anything goes.\n');
  write(r.root, 'src/app.js', 'console.log(2);\n');
  r.git('add', '-A');
  assert.equal(blocked(r), '.seal/rubrics/facts.md');
});

test('a settings-only change passes: the escape for a separate, reviewed commit', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: RUBRIC, files: ['docs/kept/**'] } }, ledger: '.seal/l2.json' }));
  write(r.root, '.seal/rubrics/consistency.md', 'Stricter.\n');
  r.git('add', '-A');
  const c = staged(r);
  assert.equal(c.code, 0, c.err);
  assert.doesNotMatch(c.err, /review settings/);
  r.git('commit', '-qm', 'config only');
  // Removing review-seal altogether is a settings-only change too.
  r.git('rm', '-q', '.seal/config.json');
  assert.equal(staged(r).code, 0);
});

test('widening coverage goes in on its own too; a first config is not blocked', () => {
  const r = base();
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { ...TWO.passes, more: { rubric: RUBRIC, files: ['src/**'] } } }));
  r.git('add', '.seal/config.json');
  assert.equal(staged(r).code, 0);
  write(r.root, 'src/app.js', 'console.log(2);\n');
  run(r.root, ['review', 'src/app.js']);
  r.git('add', '-A');
  assert.equal(blocked(r), '.seal/config.json');

  const f = sealRepo();
  f.git('add', '-A');
  assert.doesNotMatch(staged(f).err, /review settings/);
});

test('check --changed-since compares with the merge base', () => {
  const r = base();
  r.git('checkout', '-qb', 'pr');
  write(r.root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: RUBRIC, files: ['nothing/**'] } } }));
  r.git('commit', '-qam', 'narrow');
  // A settings-only branch passes.
  const ok = run(r.root, ['check', '--changed-since', 'main']);
  assert.equal(ok.code, 0, ok.err);
  // A later commit on the same branch puts content in the same change: the branch as a whole is blocked.
  write(r.root, 'docs/guide.md', 'Unreviewed claim.\n');
  r.git('commit', '-qam', 'content');
  const c = run(r.root, ['check', '--changed-since', 'main']);
  assert.equal(c.code, 1);
  assert.equal(c.err.match(SETTINGS)[1], '.seal/config.json');
});
