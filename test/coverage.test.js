import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

const notCovered = (p, root) => new RegExp(`${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is not covered by any pass \\(globs are relative to the repository root, ${root.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\)`);

test('review of a file no pass covers exits 2 and says globs are relative to the root', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'src/app.js']);
  assert.equal(r.code, 2);
  assert.match(r.err, notCovered('src/app.js', root));
  assert.doesNotMatch(r.out, /nothing needs review/);
});

test('check of a named file no pass covers says so and goes on with the rest', () => {
  const { root } = sealRepo();
  const r = run(root, ['check', 'src/app.js', 'docs/guide.md']);
  assert.equal(r.code, 1);
  assert.match(r.err, notCovered('src/app.js', root));
  assert.match(r.err, /BLOCK\s+docs\/guide\.md/);
});

test('seal of a file no pass covers names the root', () => {
  const { root } = sealRepo();
  const r = run(root, ['seal', 'src/app.js', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean']);
  assert.equal(r.code, 2);
  assert.match(r.err, notCovered('src/app.js', root));
});

test('list and bare check warn once per pass whose globs match no files', () => {
  const { root } = sealRepo({ passes: {
    consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'] },
    site: { rubric: '.seal/rubrics/consistency.md', files: ['site/docs/**/*.md', 'site/*.mdx'] },
  } });
  const want = /pass site: its globs match no files \(globs are relative to the repository root\)/;
  for (const args of [['list'], ['check']]) {
    const r = run(root, args);
    assert.match(r.err, want, args.join(' '));
    assert.equal(r.err.match(new RegExp(want.source, 'g')).length, 1);
    assert.doesNotMatch(r.err, /pass consistency: its globs/);
  }
  assert.doesNotMatch(run(root, ['check', 'docs/guide.md']).err, want);
});

test('a monorepo glob written relative to a package is caught from inside that package', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'] } } });
  write(root, 'packages/site/guides/a.md', 'x\n');
  const r = run(root, ['review', 'guides/a.md'], { cwd: join(root, 'packages/site') });
  assert.equal(r.code, 2);
  assert.match(r.err, /guides\/a\.md is not covered by any pass/);
});
