import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeToken } from './hash.js';

export class LedgerError extends Error {}
export const VERDICTS = ['clean', 'findings'];
export const REVIEWERS = ['independent', 'builder'];
export const VIAS = ['agent', 'manual'];
const HASH = /^sha256:[0-9a-f]{16}$/;

export function loadLedger(root, cfg) {
  const p = join(root, cfg.ledger);
  if (!existsSync(p)) return {};
  let led;
  try { led = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new LedgerError(`${cfg.ledger} is not valid JSON: ${e.message}`); }
  const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!plain(led) || !Object.values(led).every(plain)) throw new LedgerError(`${cfg.ledger} must map each file to its passes`);
  return led;
}

export function sortedLedger(led) {
  const out = {};
  for (const f of Object.keys(led).sort()) {
    out[f] = {};
    for (const p of Object.keys(led[f]).sort()) out[f][p] = led[f][p];
  }
  return out;
}

// Sorted keys and a trailing newline keep ledger diffs small and reviewable.
export function saveLedger(root, cfg, led) {
  const p = join(root, cfg.ledger);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(sortedLedger(led), null, 2) + '\n');
  renameSync(tmp, p);
}

export function makeEntry(file, pass, f) {
  const e = {
    at: f.at,
    contentHash: f.contentHash,
    rubricHash: f.rubricHash,
    verdict: f.verdict,
    findings: (f.findings || []).map(String),
    reviewer: f.reviewer,
    via: f.via,
  };
  e.token = computeToken(file, pass, e);
  return e;
}

export function validateEntry(file, pass, e) {
  if (!e || typeof e !== 'object') return [`no ${pass} entry`];
  const problems = [];
  if (!VERDICTS.includes(e.verdict)) problems.push(`verdict must be clean or findings (got ${JSON.stringify(e.verdict)})`);
  if (e.verdict === 'findings' && Array.isArray(e.findings) && !e.findings.some((x) => String(x).trim())) problems.push('verdict "findings" needs at least one finding');
  if (!REVIEWERS.includes(e.reviewer)) problems.push('reviewer must be independent or builder');
  if (!VIAS.includes(e.via)) problems.push('via must be agent or manual');
  if (!HASH.test(e.contentHash || '')) problems.push('missing or malformed contentHash');
  if (!HASH.test(e.rubricHash || '')) problems.push('missing or malformed rubricHash');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(e.at || '') ? new Date(e.at + 'T00:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== e.at) problems.push('missing or malformed date');
  if (!Array.isArray(e.findings)) {
    problems.push('findings must be a list');
    return problems;
  }
  if (e.token !== computeToken(file, pass, e)) problems.push('token mismatch: the ledger was edited by hand, so this review no longer counts. Run the review again.');
  return problems;
}
