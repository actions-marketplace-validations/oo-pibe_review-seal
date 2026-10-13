#!/usr/bin/env node
import { main } from '../lib/cli.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`review-seal: ${err.stack || err.message}\n`); process.exitCode = 2; },
);
