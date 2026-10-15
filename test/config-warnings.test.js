import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, write, run } from './helpers.js';

const rubric = '.seal/rubrics/consistency.md';

test('fetchDomains with a placeholder example host warns once', () => {
  const { root, git } = sealRepo({ passes: { consistency: { rubric, files: ['docs/**/*.md'], tools: ['WebFetch'], fetchDomains: ['www.example.com', 'example.org', 'docs.github.com'] } } });
  for (const args of [['list'], ['check'], ['review', '--all', '--dry-run']]) {
    const r = run(root, args);
    const hits = r.err.match(/pass consistency: fetchDomains lists placeholder hosts? \(www\.example\.com, example\.org\)/g) || [];
    assert.equal(hits.length, 1, `${args.join(' ')}: ${r.err}`);
  }
  git('add', '-A');
  assert.match(run(root, ['check', '--staged']).err, /placeholder host/);
});

test('real hosts that only contain "example" do not warn', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric, files: ['docs/**/*.md'], tools: ['WebFetch'], fetchDomains: ['example.co.uk', 'myexample.com', 'example.com.au'] } } });
  assert.doesNotMatch(run(root, ['list']).err, /placeholder/);
});

test('each glob that matches no files warns, not only whole passes', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric, files: ['docs/**/*.md', 'guides/*.md'] } } });
  for (const args of [['list'], ['check']]) {
    const r = run(root, args);
    assert.match(r.err, /pass consistency: glob "guides\/\*\.md" matches no files \(globs are relative to the repository root\)/, args.join(' '));
    assert.doesNotMatch(r.err, /docs\/\*\*/);
  }
  write(root, 'guides/a.md', 'x\n');
  assert.doesNotMatch(run(root, ['list']).err, /matches no files/);
});

test('ledger-path, prune and merge-ledger print no config warnings', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric, files: ['docs/**/*.md'], tools: ['WebFetch'], fetchDomains: ['www.example.com'] } } });
  write(root, 'other-ledger.json', '{}\n');
  for (const args of [['ledger-path'], ['prune'], ['merge-ledger', 'other-ledger.json']]) {
    const r = run(root, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.equal(r.err, '', args.join(' '));
  }
  assert.match(run(root, ['list']).err, /placeholder host/);
});
