import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const j = (p) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));

test('versions agree across package.json, plugin.json and the CLI', async () => {
  const { VERSION } = await import('../lib/cli.js');
  assert.equal(j('package.json').version, VERSION);
  assert.equal(j('.claude-plugin/plugin.json').version, VERSION);
});

test('the CLI takes its version from package.json, not a copy of its own', () => {
  assert.doesNotMatch(readFileSync(new URL('../lib/cli.js', import.meta.url), 'utf8'), /VERSION = ['"]\d/);
});

test('hooks.json wires the three events to the CLI', () => {
  const h = j('hooks/hooks.json').hooks;
  assert.deepEqual(Object.keys(h).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.match(h.PostToolUse[0].matcher, /Bash/);
  for (const [ev, arg] of [['PostToolUse', 'post-tool'], ['Stop', 'stop'], ['UserPromptSubmit', 'user-prompt']]) {
    assert.match(h[ev][0].hooks[0].command, new RegExp(`bin/review-seal\\.js" hook ${arg}$`));
  }
});

test('the plugin command that runs reviews is /review-seal:review, not a second "seal"', () => {
  assert.ok(!existsSync(new URL('../commands/seal.md', import.meta.url)));
  const md = readFileSync(new URL('../commands/review.md', import.meta.url), 'utf8');
  assert.match(md, /^allowed-tools: Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/review-seal\.js" review:\*\)$/m);
  assert.match(md, /review-seal\.js" review \$ARGUMENTS`/);
});
