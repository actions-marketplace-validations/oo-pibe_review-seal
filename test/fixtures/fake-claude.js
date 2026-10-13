#!/usr/bin/env node
// Test double for `claude -p`. Reads the prompt, echoes the hashes it was given,
// and answers according to FAKE_CLAUDE_MODE. Logs each call when FAKE_CLAUDE_LOG is set.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const pick = (k) => (prompt.match(new RegExp(`"${k}":"([^"]*)"`)) || [])[1];
const v = { file: pick('file'), pass: pick('pass'), contentHash: pick('contentHash'), rubricHash: pick('rubricHash') };
const mode = process.env.FAKE_CLAUDE_MODE || 'clean';
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ ...v, args }) + '\n');

if (mode === 'fail') { process.stderr.write('boom'); process.exit(1); }
if (mode === 'sleep') { setTimeout(() => {}, 60_000); }
else {
  let body;
  if (mode === 'garbage') body = 'I looked and it seems fine.';
  else if (mode === 'stale') body = JSON.stringify({ ...v, contentHash: 'sha256:0000000000000000', verdict: 'clean', findings: [] });
  else if (mode === 'findings') body = 'Here you go:\n```json\n' + JSON.stringify({ ...v, verdict: 'findings', findings: ['L1: says passport here, tax number elsewhere'] }) + '\n```';
  else body = JSON.stringify({ ...v, verdict: 'clean', findings: [] });
  process.stdout.write(JSON.stringify({ type: 'result', result: body }));
}
