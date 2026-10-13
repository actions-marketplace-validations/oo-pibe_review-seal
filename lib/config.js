import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { matchAny } from './glob.js';

export const CONFIG_PATH = '.seal/config.json';

export const DEFAULTS = {
  substantive: { lines: 8, patterns: [] },
  independentFrom: null,
  ledger: '.seal/ledger.json',
  autoReview: 'stop', // "stop": review when Claude finishes a turn; "commit": also at pre-commit; "off"
  maxFilesPerRun: 5,
  blockOnFindings: false,
  model: 'sonnet',
  timeoutSeconds: 300,
};

export class ConfigError extends Error {}

export function parseConfig(raw) {
  let c;
  try { c = JSON.parse(raw); } catch (e) { throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${e.message}`); }
  if (!c || typeof c !== 'object' || !c.passes || typeof c.passes !== 'object' || !Object.keys(c.passes).length) {
    throw new ConfigError(`${CONFIG_PATH} needs a "passes" object with at least one pass`);
  }
  for (const [name, p] of Object.entries(c.passes)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ConfigError(`pass name "${name}" must be lowercase letters, digits and dashes`);
    if (!p || typeof p.rubric !== 'string' || !p.rubric) throw new ConfigError(`pass "${name}" needs a "rubric" path`);
    if (!Array.isArray(p.files) || !p.files.length || !p.files.every((f) => typeof f === 'string')) {
      throw new ConfigError(`pass "${name}" needs a non-empty "files" list of globs`);
    }
  }
  const cfg = { ...DEFAULTS, ...c, substantive: { ...DEFAULTS.substantive, ...(c.substantive || {}) } };
  if (!['stop', 'commit', 'off'].includes(cfg.autoReview)) throw new ConfigError('"autoReview" must be "stop", "commit" or "off"');
  if (cfg.independentFrom !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(cfg.independentFrom))) {
    throw new ConfigError('"independentFrom" must be a YYYY-MM-DD date or null');
  }
  for (const s of cfg.substantive.patterns) {
    try { new RegExp(s, 'i'); } catch (e) { throw new ConfigError(`bad substantive pattern ${JSON.stringify(s)}: ${e.message}`); }
  }
  return cfg;
}

export function loadConfig(root) {
  const p = join(root, CONFIG_PATH);
  if (!existsSync(p)) return null;
  const cfg = parseConfig(readFileSync(p, 'utf8'));
  for (const [name, pass] of Object.entries(cfg.passes)) {
    if (!existsSync(join(root, pass.rubric))) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} does not exist`);
  }
  return cfg;
}

export function passesFor(file, cfg) {
  return Object.entries(cfg.passes).filter(([, p]) => matchAny(file, p.files)).map(([name]) => name);
}
