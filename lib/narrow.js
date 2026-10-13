import { matchAny } from './glob.js';
import { CONFIG_PATH } from './config.js';

const SHOWN = 5;

// How a change to the config narrows what the base config had under review, as a list of plain descriptions
// (empty when it does not). base and next are parsed configs (next is null when the change removes the config);
// files are the paths to judge coverage on: those present at the base and those the change touches.
// A change is never judged by rules it rewrites, so the caller blocks on any of these.
export function narrowing(base, next, files) {
  if (!base) return [];
  if (!next) return [`removes ${CONFIG_PATH}`];
  const out = [];
  for (const p of Object.keys(base.passes)) if (!(p in next.passes)) out.push(`drops the "${p}" pass`);
  const list = [...new Set(files)].filter((f) => f !== CONFIG_PATH).sort();
  for (const [p, bp] of Object.entries(base.passes)) {
    const np = next.passes[p];
    if (!np) continue;
    const lost = list.filter((f) => matchAny(f, bp.files) && !matchAny(f, np.files));
    if (!lost.length) continue;
    const names = lost.slice(0, SHOWN).join(', ') + (lost.length > SHOWN ? ` and ${lost.length - SHOWN} more` : '');
    out.push(`${names} ${lost.length === 1 ? 'is' : 'are'} no longer covered by "${p}"`);
  }
  if (base.ledger !== next.ledger) out.push(`moves the ledger from ${base.ledger} to ${next.ledger}`);
  for (const [p, bp] of Object.entries(base.passes)) {
    const np = next.passes[p];
    if (np && np.rubric !== bp.rubric) out.push(`changes the "${p}" checklist from ${bp.rubric} to ${np.rubric}`);
  }
  return out;
}
