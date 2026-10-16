#!/usr/bin/env node
// Copies the CLI into plugin/scripts/ so the plugin folder is self-contained:
// Anthropic's plugin directory scans only that folder, not the GitHub Action
// or the workflows at the repository root. test/plugin.test.js fails when the
// copy drifts, so run this after any change to bin/ or lib/.
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const out = new URL('plugin/scripts/', root);
rmSync(out, { recursive: true, force: true });
for (const dir of ['bin', 'lib']) {
  mkdirSync(new URL(dir + '/', out), { recursive: true });
  for (const f of readdirSync(new URL(dir + '/', root))) {
    copyFileSync(new URL(`${dir}/${f}`, root), new URL(`${dir}/${f}`, out));
  }
}
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
writeFileSync(new URL('package.json', out),
  JSON.stringify({ name: 'review-seal-plugin-copy', version: pkg.version, private: true, type: 'module' }, null, 2) + '\n');
