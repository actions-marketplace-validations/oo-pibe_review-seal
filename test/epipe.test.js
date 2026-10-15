import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sealRepo, write, BIN, FAKE_CLAUDE, cleanEnv } from './helpers.js';

test('list piped into head ends quietly, without a stack trace', () => {
  const { root } = sealRepo();
  // Enough output to overflow the pipe buffer after head has gone.
  for (let i = 0; i < 2500; i++) write(root, `docs/page-${String(i).padStart(5, '0')}-with-a-longer-name.md`, 'x\n');
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${BIN}" list | head -n 1`], { cwd: root, encoding: 'utf8', env: { ...cleanEnv(), REVIEW_SEAL_CLAUDE: FAKE_CLAUDE } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^docs\//);
  assert.doesNotMatch(r.stderr, /EPIPE|Error|at /);
});
