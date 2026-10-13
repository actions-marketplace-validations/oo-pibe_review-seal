import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAny, globToRegExp } from '../lib/glob.js';

test('** matches zero or more directories', () => {
  assert.ok(matchAny('docs/a.md', ['docs/**/*.md']));
  assert.ok(matchAny('docs/x/y/a.md', ['docs/**/*.md']));
  assert.ok(!matchAny('docsx/a.md', ['docs/**/*.md']));
  assert.ok(!matchAny('docs/a.txt', ['docs/**/*.md']));
});

test('* stays inside one directory, ? is one character', () => {
  assert.ok(matchAny('blog/post.md', ['blog/*.md']));
  assert.ok(!matchAny('blog/2026/post.md', ['blog/*.md']));
  assert.ok(matchAny('a1.md', ['a?.md']));
  assert.ok(!matchAny('a12.md', ['a?.md']));
});

test('dots and brackets are literal; ./ and backslashes are normalised', () => {
  assert.ok(!globToRegExp('a.md').test('abmd'));
  assert.ok(matchAny('./docs/a.md', ['docs/*.md']));
  assert.ok(matchAny('docs\\a.md', ['docs/*.md']));
  assert.ok(matchAny('x/(1).md', ['x/(1).md']));
});

test('trailing ** matches everything below', () => {
  assert.ok(matchAny('content/a/b/c.md', ['content/**']));
});

test('bracket literals and leading **/ matching top-level files', () => {
  assert.ok(matchAny('x/[1].md', ['x/[1].md']));
  assert.ok(!matchAny('x/1.md', ['x/[1].md']));
  assert.ok(matchAny('a.md', ['**/*.md']));
});

test('repeated **/ does not backtrack catastrophically', () => {
  const t = Date.now();
  assert.equal(matchAny('a/'.repeat(30) + 'x.txt', ['**/**/**/**/**/**/**/**/*.md']), false);
  // Generous, so a loaded machine does not fail it; catastrophic backtracking takes far longer.
  assert.ok(Date.now() - t < 10_000);
});

test('leading ./ or / on a glob is ignored', () => {
  assert.ok(matchAny('docs/a.md', ['/docs/*.md']));
  assert.ok(matchAny('docs/a.md', ['./docs/*.md']));
});
