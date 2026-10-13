import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealRepo, write, run } from './helpers.js';
import { ciSafe } from '../lib/text.js';

// The Actions runner reads a line as a workflow command when it starts with "::" after leading whitespace,
// and reads the legacy "##[" form anywhere in a line. Text from a reviewer or a repository must do neither.
const CI = { GITHUB_ACTIONS: 'true' };
const FINDINGS = ['x\n::stop-commands::tok', '::stop-commands::tok2', '   ::add-mask::secret', 'L2: ##[stop-commands]tok3', 'L3: ok\r::error::bad'];

function commandLines(text) {
  return text.split(/\r?\n|\r/).filter((l) => /^\s*::/.test(l) && !/^::warning file=/.test(l));
}
const legacy = (text) => text.split('\n').filter((l) => l.includes('##['));

test('ciSafe: leaves lines alone outside Actions, and defuses commands on Actions', () => {
  assert.equal(ciSafe('::stop-commands::x', {}), '::stop-commands::x');
  assert.doesNotMatch(ciSafe('::stop-commands::x', CI), /^\s*::/);
  assert.doesNotMatch(ciSafe('   ::add-mask::x', CI), /^\s*::/);
  assert.doesNotMatch(ciSafe('a ##[group]b', CI), /##\[/);
  assert.equal(ciSafe('  FLAG   docs/a.md [p] ok', CI), '  FLAG   docs/a.md [p] ok');
});

for (const cmd of [['check'], ['check', '--staged'], ['list']]) {
  test(`${cmd.join(' ')} on Actions prints no workflow command from findings`, () => {
    const { root, git } = sealRepo();
    const rv = run(root, ['review', 'docs/guide.md'], { env: { ...CI, FAKE_CLAUDE_MODE: 'custom', FAKE_CLAUDE_FINDINGS: JSON.stringify(FINDINGS) } });
    assert.equal(rv.code, 0, rv.err);
    assert.deepEqual(commandLines(rv.out + '\n' + rv.err), []);
    assert.deepEqual(legacy(rv.out + '\n' + rv.err), []);
    assert.match(rv.out, /stop-commands::tok2/);
    git('add', '-A');
    const r = run(root, cmd, { env: CI });
    assert.deepEqual(commandLines(r.out + '\n' + r.err), []);
    assert.deepEqual(legacy(r.out + '\n' + r.err), []);
  });
}

test('file names that look like workflow commands are defused on Actions', () => {
  const { root, git } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['**/*.md'] } } });
  write(root, '::stop-commands::tok.md', 'x\n');
  write(root, '##[group]g.md', 'y\n');
  git('add', '-A');
  for (const args of [['review', '--all'], ['list'], ['check'], ['check', '--staged']]) {
    const r = run(root, args, { env: { ...CI, FAKE_CLAUDE_MODE: 'custom', FAKE_CLAUDE_FINDINGS: JSON.stringify(FINDINGS) } });
    assert.deepEqual(commandLines(r.out + '\n' + r.err), [], args.join(' '));
    assert.deepEqual(legacy(r.out + '\n' + r.err), [], args.join(' '));
  }
});

test('reviewer errors from stderr cannot start a workflow command on Actions', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'docs/guide.md'], { env: { ...CI, FAKE_CLAUDE_MODE: 'fail', FAKE_CLAUDE_STDERR: '\n::stop-commands::tok\n##[group]x' } });
  assert.equal(r.code, 1);
  assert.deepEqual(commandLines(r.out + '\n' + r.err), []);
  assert.deepEqual(legacy(r.out + '\n' + r.err), []);
});

test('outside Actions the output is unchanged', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'custom', FAKE_CLAUDE_FINDINGS: JSON.stringify(['::stop-commands::tok2']) } });
  assert.match(r.out, /^    ::stop-commands::tok2$/m);
});
