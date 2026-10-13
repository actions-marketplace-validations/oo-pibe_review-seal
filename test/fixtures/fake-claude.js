#!/usr/bin/env node
// Test double for `claude -p`. Reads the prompt, echoes the hashes it was given,
// and answers according to FAKE_CLAUDE_MODE. Logs each call when FAKE_CLAUDE_LOG is set.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.includes('-p')) { process.stderr.write('fake-claude: missing -p\n'); process.exit(2); }
const prompt = args[args.indexOf('-p') + 1] || '';
const pick = (k) => (prompt.match(new RegExp(`"${k}":"([^"]*)"`)) || [])[1];
const v = { file: pick('file'), pass: pick('pass'), contentHash: pick('contentHash'), rubricHash: pick('rubricHash') };
const mode = process.env.FAKE_CLAUDE_MODE || 'clean';
// Whether checkout's credentials are readable in the repository's git config while the reviewer runs.
function gitAuth() { try { return /extraheader/i.test(readFileSync('.git/config', 'utf8')); } catch { return null; } }
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ ...v, args, pid: process.pid, claudecode: process.env.CLAUDECODE ?? null, projectDir: process.env.CLAUDE_PROJECT_DIR ?? null, child: process.env.REVIEW_SEAL_CHILD ?? null, ghToken: process.env.GH_TOKEN ?? null, gitAuth: gitAuth() }) + '\n');

if (mode === 'fail') { process.stderr.write(process.env.FAKE_CLAUDE_STDERR || 'boom'); process.exit(1); }
if (mode === 'sleep-grandchild') {
  const g = spawn('sh', ['-c', 'trap "" TERM; exec sleep 30'], { stdio: 'ignore' });
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ gpid: g.pid }) + '\n');
  setTimeout(() => {}, 60_000);
} else if (mode === 'sleep') { setTimeout(() => {}, 60_000); }
else {
  let body;
  if (mode === 'garbage') body = 'I looked and it seems fine.';
  else if (mode === 'stale') body = JSON.stringify({ ...v, contentHash: 'sha256:0000000000000000', verdict: 'clean', findings: [] });
  else if (mode === 'findings') body = 'Here you go:\n```json\n' + JSON.stringify({ ...v, verdict: 'findings', findings: ['L1: says passport here, tax number elsewhere'] }) + '\n```';
  else if (mode === 'custom') body = JSON.stringify({ ...v, verdict: 'findings', findings: JSON.parse(process.env.FAKE_CLAUDE_FINDINGS) });
  else body = JSON.stringify({ ...v, verdict: 'clean', findings: [] });
  process.stdout.write(JSON.stringify({ type: 'result', result: body }));
}
