import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig, configWarnings, passesFor } from '../lib/config.js';
import { tmpRepo, run } from './helpers.js';

const GTM = fileURLToPath(new URL('../examples/gtm', import.meta.url));
const SAMPLES = ['sequences/q4-reengage.yaml', 'battlecards/northwind-crm.md', 'content/blog/crm-data-quality.md'];

test('examples/gtm: the config parses, its checklists exist, and each pass covers a sample', () => {
  const cfg = loadConfig(GTM);
  assert.deepEqual(Object.keys(cfg.passes).sort(), ['battlecard', 'blog-facts', 'outreach']);
  assert.deepEqual(configWarnings(cfg), []);
  for (const p of Object.values(cfg.passes)) assert.ok(existsSync(join(GTM, p.rubric)), p.rubric);
  // No WebFetch: a sample cannot know which hosts a reader's reviewer should fetch from.
  for (const p of Object.values(cfg.passes)) assert.ok(!p.tools.includes('WebFetch'));
  assert.deepEqual(SAMPLES.map((f) => passesFor(f, cfg)), [['outreach'], ['battlecard'], ['blog-facts']]);
  assert.ok(existsSync(join(GTM, 'data/approved-claims.md')));
});

test('examples/gtm works as a repository: list is quiet and a dry run finds the three samples', () => {
  const { root } = tmpRepo();
  cpSync(GTM, root, { recursive: true });
  const l = run(root, ['list']);
  assert.equal(l.code, 0, l.err);
  assert.doesNotMatch(l.err, /review-seal:/);
  const d = run(root, ['review', '--all', '--dry-run']);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /^3 files across 3 passes$/m);
});

test('examples/ stays out of the npm package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.files.some((f) => f.startsWith('examples')));
});
