import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './hash.js';
import { passesFor } from './config.js';
import { trackedAndUntracked } from './git.js';

export function coveredFiles(root, cfg) {
  return [...new Set(trackedAndUntracked(root))]
    .filter((f) => passesFor(f, cfg).length && lstatSync(join(root, f), { throwIfNoEntry: false })?.isFile())
    .sort();
}

export function rubricHashes(root, cfg) {
  const out = {};
  for (const [name, p] of Object.entries(cfg.passes)) out[name] = contentHash(readFileSync(join(root, p.rubric), 'utf8'));
  return out;
}
