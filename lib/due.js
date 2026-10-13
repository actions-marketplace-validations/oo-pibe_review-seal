import { validateEntry } from './ledger.js';
import { sanitizeText } from './text.js';

// The body of the scheduled re-review pull request: every review the scheduled branch renews against the base
// (so findings from earlier runs stay visible when a later run edits the body), then the latest run's log.
// Everything is shown inside fences, as text: a finding cannot ping anyone or add links.
const MAX = 60000;
const SUMMARY_MAX = 30000;

const fenceFor = (text) => '~'.repeat(Math.max(3, Math.max(0, ...(text.match(/~+/g) || []).map((r) => r.length)) + 1));
const fenced = (text) => {
  const f = fenceFor(text);
  return `${f}\n${text}${text.endsWith('\n') || !text ? '' : '\n'}${f}\n`;
};
const parse = (t) => {
  try {
    const o = JSON.parse(t);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
};

export function renewedEntries(baseText, newText) {
  const base = parse(baseText);
  const next = parse(newText);
  const out = [];
  for (const file of Object.keys(next).sort()) {
    const passes = next[file];
    if (!passes || typeof passes !== 'object') continue;
    for (const pass of Object.keys(passes).sort()) {
      const e = passes[pass];
      if (!e || typeof e !== 'object' || validateEntry(file, pass, e).length) continue;
      if (base[file]?.[pass]?.token === e.token) continue;
      out.push({ file, pass, verdict: e.verdict, at: e.at, findings: Array.isArray(e.findings) ? e.findings : [] });
    }
  }
  return out;
}

export function dueBody({ baseLedger = '', newLedger = '', log = '' }) {
  const renewed = renewedEntries(baseLedger, newLedger);
  let summary = renewed.map((r) => [
    `${sanitizeText(r.file)} [${sanitizeText(r.pass)}] ${sanitizeText(r.verdict)} (reviewed ${sanitizeText(r.at)})`,
    ...r.findings.map((f) => `    ${sanitizeText(f)}`),
  ].join('\n')).join('\n');
  const summaryCut = summary.length > SUMMARY_MAX;
  if (summaryCut) summary = summary.slice(0, SUMMARY_MAX);
  // Each line of the log is shown as text, never as terminal control sequences.
  let text = String(log).split(/\r?\n/).map(sanitizeText).join('\n');
  const room = MAX - summary.length;
  const cut = text.length > room;
  if (cut) text = text.slice(0, Math.max(0, room));
  let body = 'Scheduled re-review of files that were stale or past their shelf life.\n\n';
  if (renewed.length) {
    body += `Reviews this pull request renews (${renewed.length}):\n\n${fenced(summary)}${summaryCut ? '\nlist truncated; see the ledger diff\n' : ''}\n`;
  }
  body += `Log of the latest run:\n\n${fenced(text)}${cut ? '\nlog truncated; see the workflow run\n' : ''}`;
  return body;
}
