import { passesFor } from './config.js';
import { validateEntry } from './ledger.js';

const selfReviewAfterCutoff = (e, cfg) => Boolean(cfg.independentFrom) && e.at >= cfg.independentFrom && e.reviewer !== 'independent';

// Does this (file, pass) need a new independent review? Used by the auto-reviewer and the hook.
export function needsReview(file, pass, ledger, { contentHash, rubricHash }, cfg) {
  const e = (ledger[file] || {})[pass];
  if (!e) return true;
  if (validateEntry(file, pass, e).length) return true;
  if (e.contentHash !== contentHash || e.rubricHash !== rubricHash) return true;
  return selfReviewAfterCutoff(e, cfg);
}

// items: [{ file, contentHash, rubricHashes: { pass: hash }, change: { substantive, why, sample? } }]
export function evaluate(items, ledger, cfg) {
  const blocks = [];
  const warnings = [];
  const counts = { independent: 0, builder: 0 };
  for (const it of items) {
    for (const pass of passesFor(it.file, cfg)) {
      const e = (ledger[it.file] || {})[pass];
      const at = { file: it.file, pass };
      const soft = !it.change.substantive;
      const why = it.change.why + (it.change.sample ? `: "${it.change.sample}"` : '');
      if (!e) {
        (soft ? warnings : blocks).push({ ...at, reason: 'never-reviewed', message: `never reviewed (${why})` });
        continue;
      }
      const problems = validateEntry(it.file, pass, e);
      if (problems.length) {
        blocks.push({ ...at, reason: 'invalid', message: problems.join('; ') });
        continue;
      }
      counts[e.reviewer]++;
      // Every rule is checked on its own so a soft result never hides a hard one.
      // A later task adds an independent 'expired' rule alongside these.
      if (e.contentHash !== it.contentHash) {
        (soft ? warnings : blocks).push({ ...at, reason: 'stale', message: `reviewed ${e.at}, then the file changed (${why})` });
      }
      if (e.rubricHash !== it.rubricHashes[pass]) {
        blocks.push({ ...at, reason: 'rubric-changed', message: `reviewed ${e.at} against an older version of the ${pass} checklist` });
      }
      if (selfReviewAfterCutoff(e, cfg)) {
        blocks.push({ ...at, reason: 'self-review', message: `sealed by the builder on ${e.at}; from ${cfg.independentFrom} only an independent review counts` });
      }
      if (e.verdict === 'findings') {
        // Findings never block by default: they are flagged at every save until the file is fixed and re-reviewed.
        (cfg.blockOnFindings ? blocks : warnings).push({ ...at, reason: 'findings', findings: e.findings, message: `open finding${e.findings.length === 1 ? '' : 's'} from the ${e.at} review: ${e.findings.join(' | ')}` });
      }
    }
  }
  return { blocks, warnings, counts };
}
