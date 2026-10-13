import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, loadConfig, passesFor, ConfigError } from '../lib/config.js';

const ok = { passes: { consistency: { rubric: 'r.md', files: ['docs/**/*.md'] }, 'fact-check': { rubric: 'f.md', files: ['docs/guides/*.md'] } } };

test('fills defaults', () => {
  const c = parseConfig(JSON.stringify(ok));
  assert.equal(c.autoReview, 'stop');
  assert.equal(c.maxFilesPerRun, 5);
  assert.equal(c.blockOnFindings, false);
  assert.equal(c.independentFrom, null);
  assert.equal(c.ledger, '.seal/ledger.json');
  assert.deepEqual(c.substantive, { lines: 8, patterns: [] });
});

test('rejects bad config with a plain message', () => {
  const bad = [
    ['{', /not valid JSON/],
    ['{}', /needs a "passes" object/],
    [JSON.stringify({ passes: { Bad_Name: { rubric: 'r', files: ['x'] } } }), /lowercase/],
    [JSON.stringify({ passes: { a: { files: ['x'] } } }), /needs a "rubric"/],
    [JSON.stringify({ passes: { a: { rubric: 'r', files: [] } } }), /non-empty "files"/],
    [JSON.stringify({ ...ok, autoReview: 'always' }), /"autoReview"/],
    [JSON.stringify({ ...ok, independentFrom: 'soon' }), /"independentFrom"/],
    [JSON.stringify({ ...ok, substantive: { patterns: ['('] } }), /bad substantive pattern/],
  ];
  for (const [raw, msg] of bad) assert.throws(() => parseConfig(raw), (e) => e instanceof ConfigError && msg.test(e.message), raw);
});

test('passesFor lists every pass covering a file', () => {
  const c = parseConfig(JSON.stringify(ok));
  assert.deepEqual(passesFor('docs/guides/a.md', c), ['consistency', 'fact-check']);
  assert.deepEqual(passesFor('docs/a.md', c), ['consistency']);
  assert.deepEqual(passesFor('src/a.js', c), []);
});

test('loadConfig: null without a config, error when a rubric is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-cfg-'));
  assert.equal(loadConfig(root), null);
  mkdirSync(join(root, '.seal'));
  writeFileSync(join(root, '.seal/config.json'), JSON.stringify(ok));
  assert.throws(() => loadConfig(root), /rubric r\.md does not exist/);
  writeFileSync(join(root, 'r.md'), 'x');
  writeFileSync(join(root, 'f.md'), 'y');
  assert.equal(loadConfig(root).passes.consistency.rubric, 'r.md');
});
