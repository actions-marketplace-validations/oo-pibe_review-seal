import { spawn } from 'node:child_process';

export function buildPrompt({ file, pass, rubricPath, contentHash, rubricHash }) {
  return [
    'You are an independent reviewer. You did not write this file and you know nothing about how it was made.',
    `Read the checklist at ${rubricPath}, then read ${file} in full. Apply only that checklist.`,
    'You may read other files in this repository to check the file against them. You cannot and must not edit anything.',
    'Report each problem the checklist asks about as one line that starts with the line number, like "L12: ...". If there are none, the verdict is clean.',
    'Reply with one JSON object and nothing else, in this shape:',
    JSON.stringify({ file, pass, contentHash, rubricHash, verdict: 'clean | findings', findings: ['L12: ...'] }),
    'Copy file, pass, contentHash and rubricHash exactly as given above.',
  ].join('\n\n');
}

function shape(o) {
  if (!o || typeof o !== 'object' || !['clean', 'findings'].includes(o.verdict)) return null;
  const findings = Array.isArray(o.findings) ? o.findings.map(String).filter((s) => s.trim()) : [];
  if (o.verdict === 'findings' && !findings.length) return null;
  return { file: o.file, pass: o.pass, contentHash: o.contentHash, rubricHash: o.rubricHash, verdict: o.verdict, findings: o.verdict === 'clean' ? [] : findings };
}

// Every balanced {...} in the text, string-aware. The model sometimes wraps its object in prose
// or a code fence; a greedy first-brace-to-last-brace match then spans junk and fails to parse.
function objectCandidates(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); break; }
    }
  }
  return out;
}

export function extractVerdict(stdout) {
  let text = String(stdout);
  try {
    const o = JSON.parse(text);
    if (o && typeof o.result === 'string') text = o.result;
    else { const v = shape(o); if (v) return v; }
  } catch { /* not a single JSON document; scan it */ }
  for (const c of objectCandidates(text).reverse()) {
    try { const v = shape(JSON.parse(c)); if (v) return v; } catch { /* next */ }
  }
  return null;
}

export function runReviewer(job, { root, claude = process.env.REVIEW_SEAL_CLAUDE || 'claude', model, timeoutSeconds = 300 }) {
  return new Promise((resolve) => {
    const args = ['-p', buildPrompt(job), '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob', '--output-format', 'json', '--no-session-persistence'];
    if (model) args.push('--model', model);
    // stdin is ignored on purpose: claude reads stdin, and an inherited pipe can swallow a caller's input.
    // REVIEW_SEAL_CHILD stops our own hooks from firing inside the reviewer's session.
    const child = spawn(claude, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REVIEW_SEAL_CHILD: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ ok: false, error: `reviewer timed out after ${timeoutSeconds}s` }); }, timeoutSeconds * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.code === 'ENOENT' ? `"${claude}" not found; install Claude Code to run reviews` : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: `reviewer exited ${code}: ${err.trim().slice(0, 200)}` });
      const v = extractVerdict(out);
      resolve(v ? { ok: true, verdict: v } : { ok: false, error: 'could not read a verdict from the reviewer output' });
    });
  });
}
