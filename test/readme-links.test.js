import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// npm renders the README without rewriting relative links, so on npmjs.com
// every relative link and image breaks. All links must be absolute.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const targets = [...readme.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]);

test('README.md has no relative markdown links or images', () => {
  assert.ok(targets.length > 0, 'expected the README to have links');
  const relative = targets.filter((t) => !/^(https?:\/\/|mailto:|#)/.test(t));
  assert.deepEqual(relative, []);
  assert.doesNotMatch(readme, /<(img|a)\b[^>]*\b(src|href)="(?!https?:\/\/|#)/i);
});

test("README.md links into this repository point at files that exist", () => {
  const prefix = /^https:\/\/(?:github\.com\/oo-pibe\/review-seal\/(?:blob|tree)\/main|raw\.githubusercontent\.com\/oo-pibe\/review-seal\/main)\/([^#?]+)/;
  const local = targets.map((t) => t.match(prefix)?.[1]).filter(Boolean);
  assert.ok(local.length > 0);
  const missing = local.filter((p) => !existsSync(join(root, decodeURIComponent(p))));
  assert.deepEqual(missing, []);
});
