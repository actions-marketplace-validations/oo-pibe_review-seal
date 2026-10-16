import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const j = (p) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));

test('versions agree across package.json, plugin.json and the CLI', async () => {
  const { VERSION } = await import('../lib/cli.js');
  assert.equal(j('package.json').version, VERSION);
  assert.equal(j('plugin/.claude-plugin/plugin.json').version, VERSION);
  assert.equal(j('plugin/scripts/package.json').version, VERSION);
});

test('the CLI takes its version from package.json, not a copy of its own', () => {
  assert.doesNotMatch(readFileSync(new URL('../lib/cli.js', import.meta.url), 'utf8'), /VERSION = ['"]\d/);
});

test('hooks.json wires the three events to the CLI', () => {
  const h = j('plugin/hooks/hooks.json').hooks;
  assert.deepEqual(Object.keys(h).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.match(h.PostToolUse[0].matcher, /Bash/);
  for (const [ev, arg] of [['PostToolUse', 'post-tool'], ['Stop', 'stop'], ['UserPromptSubmit', 'user-prompt']]) {
    assert.match(h[ev][0].hooks[0].command, new RegExp(`scripts/bin/review-seal\\.js" hook ${arg}$`));
  }
});

test('the plugin command that runs reviews is /review-seal:review, not a second "seal"', () => {
  assert.ok(!existsSync(new URL('../plugin/commands/seal.md', import.meta.url)));
  const md = readFileSync(new URL('../plugin/commands/review.md', import.meta.url), 'utf8');
  assert.match(md, /^allowed-tools: Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/bin\/review-seal\.js" review:\*\)$/m);
  assert.match(md, /review-seal\.js" review \$ARGUMENTS`/);
});

test('the plugin folder carries an exact copy of bin/ and lib/ (run node tools/build-plugin.js)', () => {
  for (const dir of ['bin', 'lib']) {
    const src = readdirSync(new URL(`../${dir}/`, import.meta.url)).sort();
    assert.deepEqual(readdirSync(new URL(`../plugin/scripts/${dir}/`, import.meta.url)).sort(), src, dir);
    for (const f of src) {
      assert.equal(readFileSync(new URL(`../plugin/scripts/${dir}/${f}`, import.meta.url), 'utf8'),
        readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8'), `${dir}/${f}`);
    }
  }
  assert.equal(j('plugin/scripts/package.json').type, 'module');
});

test('the marketplace points at the plugin folder, which holds no Action or workflow files', () => {
  assert.equal(j('.claude-plugin/marketplace.json').plugins[0].source, './plugin');
  assert.ok(!existsSync(new URL('../.claude-plugin/plugin.json', import.meta.url)));
  for (const f of ['action.yml', '.github', 'bin']) assert.ok(!existsSync(new URL('../plugin/' + f, import.meta.url)), f);
});
