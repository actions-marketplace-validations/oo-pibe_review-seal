---
description: Run the independent review now for a file (reviews also run on their own when you finish a turn)
argument-hint: <file> [more files]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/review-seal.js" review:*)
---

Run the review-seal reviewer now on: $ARGUMENTS

Run exactly this, then report each file's verdict and findings to the user in plain words:

`node "${CLAUDE_PLUGIN_ROOT}/bin/review-seal.js" review $ARGUMENTS`

Do not edit `.seal/ledger.json` yourself and do not run `review-seal seal`. If a finding is real, fix the file; the fix is reviewed again automatically when this turn ends.
