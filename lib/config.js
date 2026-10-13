import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
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

const safeRelative = (x) => typeof x === 'string' && x.trim() !== '' && !isAbsolute(x) && !/^[A-Za-z]:/.test(x) && !x.split(/[\\/]/).includes('..');
const realDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const inside = (root, x) => (resolve(root, x) + sep).startsWith(resolve(root) + sep) && resolve(root, x) !== resolve(root);

// The reviewer is always read-only. A pass may add live-source lookups, nothing else.
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

// Suffixes under which anyone can register or publish a name, so a wildcard over them would let the reviewer fetch
// from (and send data to) hosts nobody vetted. Not the full public suffix list: country second levels such as
// co.uk or com.au, and the common shared hosting platforms.
const SHARED_SUFFIXES = new Set(['vercel.app', 'netlify.app', 'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'onrender.com', 'fly.dev', 'glitch.me', 'surge.sh',
  'ngrok.io', 'ngrok-free.app', 'repl.co', 'substack.com', 'medium.com', 'wordpress.com', 'tumblr.com', 'neocities.org', 'readthedocs.io']);
const COUNTRY_SECOND = /^(co|com|net|org|gov|ac|edu|ne|or|go|gob|nic|ltd|plc|me)\.[a-z]{2}$/;
export const openWildcard = (d) => {
  if (!d.startsWith('*.')) return false;
  const rest = d.slice(2).toLowerCase();
  return !rest.includes('.') || SHARED_SUFFIXES.has(rest) || COUNTRY_SECOND.test(rest);
};
const hostRule = (d) => typeof d === 'string' && d.length <= 253 && /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d);

export function parseConfig(raw) {
  let c;
  try { c = JSON.parse(raw); } catch (e) { throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${e.message}`); }
  if (!c || typeof c !== 'object' || !c.passes || typeof c.passes !== 'object' || Array.isArray(c.passes) || !Object.keys(c.passes).length) {
    throw new ConfigError(`${CONFIG_PATH} needs a "passes" object with at least one pass`);
  }
  for (const [name, p] of Object.entries(c.passes)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ConfigError(`pass name "${name}" must be lowercase letters, digits and dashes`);
    if (!p || typeof p.rubric !== 'string' || !p.rubric) throw new ConfigError(`pass "${name}" needs a "rubric" path`);
    if (!safeRelative(p.rubric)) throw new ConfigError(`pass "${name}": "rubric" must be a non-empty relative path inside the repo`);
    if (!Array.isArray(p.files) || !p.files.length || !p.files.every((f) => typeof f === 'string' && f.trim() !== '')) {
      throw new ConfigError(`pass "${name}" needs a non-empty "files" list of globs`);
    }
    if (p.maxAgeDays !== undefined && p.maxAgeDays !== null && !(Number.isInteger(p.maxAgeDays) && p.maxAgeDays > 0)) {
      throw new ConfigError(`pass "${name}": "maxAgeDays" must be a positive whole number or null`);
    }
    if (p.tools !== undefined && (!Array.isArray(p.tools) || !p.tools.every((t) => WEB_TOOLS.includes(t)) || new Set(p.tools).size !== p.tools.length)) {
      throw new ConfigError(`pass "${name}": "tools" may list only WebSearch and WebFetch, each at most once`);
    }
    // WebFetch is allowed only for listed hosts (Claude Code rules "WebFetch(domain:x)"), so a reviewer that
    // read something sensitive cannot send it to an arbitrary URL. A leading "*." covers subdomains.
    const fetches = Array.isArray(p.tools) && p.tools.includes('WebFetch');
    const open = Array.isArray(p.fetchDomains) && p.fetchDomains.find((d) => typeof d === 'string' && openWildcard(d));
    if (open) throw new ConfigError(`pass "${name}": "fetchDomains" entry "${open}" covers names anyone can publish under; list the hosts themselves, or a wildcard under a name you trust such as "*.example.com"`);
    if (p.fetchDomains !== undefined && (!Array.isArray(p.fetchDomains) || !p.fetchDomains.every(hostRule))) {
      throw new ConfigError(`pass "${name}": "fetchDomains" must be a list of host names such as "example.com" or "*.example.com"`);
    }
    if (fetches && !(p.fetchDomains || []).length) throw new ConfigError(`pass "${name}": WebFetch needs "fetchDomains", the hosts the reviewer may fetch from`);
    if (!fetches && (p.fetchDomains || []).length) throw new ConfigError(`pass "${name}": "fetchDomains" needs WebFetch in "tools"`);
    p.maxAgeDays ??= null;
    p.tools ??= [];
    p.fetchDomains ??= [];
  }
  if ('substantive' in c && (!c.substantive || typeof c.substantive !== 'object' || Array.isArray(c.substantive))) throw new ConfigError('"substantive" must be an object');
  const cfg = { ...DEFAULTS, ...c, substantive: { ...DEFAULTS.substantive, ...(c.substantive || {}) } };
  if (!safeRelative(cfg.ledger) || /[\\/]$/.test(cfg.ledger)) throw new ConfigError('"ledger" must be a non-empty relative path inside the repo');
  if (!Number.isInteger(cfg.maxFilesPerRun) || cfg.maxFilesPerRun < 1) throw new ConfigError('"maxFilesPerRun" must be a whole number of 1 or more');
  if (typeof cfg.timeoutSeconds !== 'number' || !(cfg.timeoutSeconds >= 1) || cfg.timeoutSeconds > 1800) throw new ConfigError('"timeoutSeconds" must be a number between 1 and 1800');
  if (typeof cfg.blockOnFindings !== 'boolean') throw new ConfigError('"blockOnFindings" must be true or false');
  if (typeof cfg.model !== 'string' || !/^[A-Za-z0-9._:@\/\[\]-]+$/.test(cfg.model) || cfg.model.startsWith('-')) throw new ConfigError('"model" must be a plain model name such as "sonnet"');
  if (!cfg.substantive || typeof cfg.substantive !== 'object' || Array.isArray(cfg.substantive)) throw new ConfigError('"substantive" must be an object');
  if (!Number.isInteger(cfg.substantive.lines) || cfg.substantive.lines < 0) throw new ConfigError('"substantive.lines" must be a whole number of 0 or more');
  if (!Array.isArray(cfg.substantive.patterns) || !cfg.substantive.patterns.every((x) => typeof x === 'string')) throw new ConfigError('"substantive.patterns" must be a list of strings');
  if (!['stop', 'commit', 'off'].includes(cfg.autoReview)) throw new ConfigError('"autoReview" must be "stop", "commit" or "off"');
  if (cfg.independentFrom !== null && !realDate(String(cfg.independentFrom))) {
    throw new ConfigError('"independentFrom" must be a YYYY-MM-DD date or null');
  }
  for (const s of cfg.substantive.patterns) {
    let re;
    try { re = new RegExp(s, 'i'); } catch (e) { throw new ConfigError(`bad substantive pattern ${JSON.stringify(s)}: ${e.message}`); }
    if (re.test('')) throw new ConfigError(`pattern ${JSON.stringify(s)} matches empty text`);
  }
  return cfg;
}

export function loadConfig(root) {
  const p = join(root, CONFIG_PATH);
  if (!existsSync(p)) return null;
  const cfg = parseConfig(readFileSync(p, 'utf8'));
  if (!inside(root, cfg.ledger)) throw new ConfigError('"ledger" must stay inside the repo');
  for (const [name, pass] of Object.entries(cfg.passes)) {
    if (!inside(root, pass.rubric)) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} must stay inside the repo`);
    const rp = join(root, pass.rubric);
    if (!existsSync(rp)) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} does not exist`);
    if (!statSync(rp).isFile()) throw new ConfigError(`pass "${name}": rubric ${pass.rubric} is not a file`);
  }
  return cfg;
}

export function passesFor(file, cfg) {
  return Object.entries(cfg.passes).filter(([, p]) => matchAny(file, p.files)).map(([name]) => name);
}
