const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

// How much of `a` survives in `b`, 0..1. Pairs a rewritten line with the line it replaced.
function overlap(a, b) {
  const bw = new Set(words(b));
  const aw = words(a);
  if (!aw.length) return 0;
  return aw.filter((w) => bw.has(w)).length / aw.length;
}

// A markdown paragraph is one long line, so appending a clause makes git report the whole
// paragraph as added. Testing the raw added line would flag every edit to a paragraph that
// already made a claim. So a pattern hit counts only when the replaced line did not match it.
export function classifyChange(diffText, rule) {
  const all = String(diffText).split('\n');
  const start = all.findIndex((l) => l.startsWith('@@'));
  const body = start < 0 ? [] : all.slice(start).filter((l) => /^[+-]/.test(l));
  if (!body.length) return { substantive: false, why: 'no text changes' };

  const patterns = (rule.patterns || []).map((s) => new RegExp(s, 'i'));
  if (!patterns.length) return { substantive: true, why: 'changes the text' };

  const added = body.filter((l) => l[0] === '+').map((l) => l.slice(1));
  const removed = body.filter((l) => l[0] === '-').map((l) => l.slice(1));
  const touched = Math.max(added.length, removed.length);
  if (touched >= rule.lines) return { substantive: true, why: `touches ${touched} lines` };

  for (const line of added) {
    const hits = patterns.filter((re) => re.test(line));
    if (!hits.length) continue;
    let best = '';
    let score = 0;
    for (const r of removed) {
      const s = overlap(line, r);
      if (s > score) { score = s; best = r; }
    }
    if (hits.some((re) => !(score >= 0.5 && re.test(best)))) {
      return { substantive: true, why: 'adds a line matching a claim pattern', sample: line.trim().slice(0, 80) };
    }
  }
  return { substantive: false, why: `small edit (${touched} line${touched === 1 ? '' : 's'}) with no new claim` };
}
