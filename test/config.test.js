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

test('path safety: ledger and rubric must be relative, inside the repo', () => {
  const withLedger = (ledger) => JSON.stringify({ ...ok, ledger });
  const withRubric = (rubric) => JSON.stringify({ passes: { a: { rubric, files: ['x'] } } });
  assert.throws(() => parseConfig(withLedger('')), /"ledger" must be a non-empty relative path/);
  assert.throws(() => parseConfig(withLedger('/etc/l.json')), /"ledger" must be a non-empty relative path/);
  assert.throws(() => parseConfig(withLedger('../l.json')), /"ledger" must be a non-empty relative path/);
  assert.throws(() => parseConfig(withLedger('a/../../l.json')), /"ledger" must be a non-empty relative path/);
  assert.throws(() => parseConfig(withRubric('/etc/passwd')), /pass "a": "rubric" must be a non-empty relative path/);
  assert.throws(() => parseConfig(withRubric('../r.md')), /pass "a": "rubric" must be a non-empty relative path/);
  assert.throws(() => parseConfig(withRubric(5)), /needs a "rubric"/);
});

test('loadConfig: rubric must be a regular file', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-cfg-'));
  mkdirSync(join(root, '.seal'));
  mkdirSync(join(root, 'rdir'));
  writeFileSync(join(root, '.seal/config.json'), JSON.stringify({ passes: { a: { rubric: 'rdir', files: ['x'] } } }));
  assert.throws(() => loadConfig(root), /rubric rdir is not a file/);
});

test('config types are checked', () => {
  const t = (over, msg) => assert.throws(() => parseConfig(JSON.stringify({ ...ok, ...over })), (e) => e instanceof ConfigError && msg.test(e.message), JSON.stringify(over));
  t({ maxFilesPerRun: 0 }, /"maxFilesPerRun" must be a whole number of 1 or more/);
  t({ maxFilesPerRun: 1.5 }, /"maxFilesPerRun"/);
  t({ timeoutSeconds: 0 }, /"timeoutSeconds" must be a number between 1 and 1800/);
  t({ timeoutSeconds: 5000 }, /"timeoutSeconds"/);
  t({ blockOnFindings: 'yes' }, /"blockOnFindings" must be true or false/);
  t({ model: '--evil' }, /"model" must be a plain model name/);
  t({ model: 'a b' }, /"model"/);
  t({ model: 3 }, /"model"/);
  t({ substantive: { lines: -1 } }, /"substantive.lines" must be a whole number of 0 or more/);
  t({ substantive: { patterns: 'x' } }, /"substantive.patterns" must be a list of strings/);
  t({ substantive: { patterns: [1] } }, /"substantive.patterns" must be a list of strings/);
  t({ independentFrom: '2026-02-31' }, /"independentFrom"/);
  assert.throws(() => parseConfig(JSON.stringify({ passes: [{ rubric: 'r', files: ['x'] }] })), /needs a "passes" object/);
  assert.throws(() => parseConfig(JSON.stringify({ passes: { a: { rubric: 'r', files: ['  '] } } })), /non-empty "files"/);
  assert.throws(() => parseConfig(JSON.stringify({ passes: { a: { rubric: 'r', files: [''] } } })), /non-empty "files"/);
});

test('edge cases: model forms, sub-second timeout, substantive type, ledger dir path', () => {
  const run = (over) => parseConfig(JSON.stringify({ ...ok, ...over }));
  for (const m of ['claude-sonnet-4-5@20250929', 'sonnet[1m]', 'arn:aws:bedrock:us-east-1:1:inference-profile/x.y']) assert.equal(run({ model: m }).model, m);
  assert.throws(() => run({ model: '-x@1' }), /"model" must be a plain model name/);
  assert.throws(() => run({ model: 'a b' }), /"model"/);
  assert.throws(() => run({ timeoutSeconds: 0.5 }), /"timeoutSeconds" must be a number between 1 and 1800/);
  assert.equal(run({ timeoutSeconds: 1 }).timeoutSeconds, 1);
  assert.throws(() => run({ substantive: 'x' }), /"substantive" must be an object/);
  assert.throws(() => run({ substantive: [] }), /"substantive" must be an object/);
  assert.throws(() => run({ substantive: null }), /"substantive" must be an object/);
  assert.throws(() => run({ ledger: '.seal/' }), /"ledger" must be a non-empty relative path/);
  assert.throws(() => run({ ledger: '.seal\\' }), /"ledger" must be a non-empty relative path/);
});
