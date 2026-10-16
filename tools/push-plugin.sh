#!/bin/sh
# Publishes plugin/ as the root of oo-pibe/review-seal-plugin, the repository
# Anthropic's plugin directory reads (a plugin at a repository root is one the
# directory's validator can follow). Run from a clean, pushed main.
set -eu
cd "$(git rev-parse --show-toplevel)"
test -z "$(git status --porcelain)" || { echo "commit or stash first"; exit 1; }
node tools/build-plugin.js
test -z "$(git status --porcelain)" || { echo "plugin/scripts was out of date; commit the rebuilt copy first"; exit 1; }
split=$(git subtree split --prefix plugin)
git push https://github.com/oo-pibe/review-seal-plugin.git "$split:refs/heads/main"
echo "review-seal-plugin main is now $split (tree $(git rev-parse "$split^{tree}"))"
