# review-seal

Prove each version of a file got an independent review.

For teams that use AI to write marketing, sales and docs content: it checks each page against your rules (prices, competitor claims, personalisation tokens, opt-out lines) before the change can be committed, and re-checks fact-based pages on a schedule.

Claude Code plugin, git pre-commit hook and GitHub Action.

![review-seal demo: a commit is blocked until a fresh reviewer has read the file](docs/demo.svg)

A 60-second run on the example project. The reviews are real; the waits are shortened.

## Why revenue teams care

A wrong price, an out-of-date competitor claim or a broken `{first_name}` token that reaches a prospect costs deals. review-seal holds the change until a reviewer has checked it against your checklist, and re-checks fact-based pages every 30 or 90 days, even ones nobody edited.

The reviewer is a fresh Claude Code session that never saw the conversation that wrote the page. Each result is recorded in the repository against the exact text and checklist it read, so changing either one sends the page back for review.

How it has done so far:

- Replayed on earlier versions of my own travel guides, the ones that later needed fixes, it caught 4 of 4 contradictions within a single page and missed the one that spanned two pages. On six control pages it raised no clear false alarms.
- A review of a guide-length page cost 8 to 22 cents on Sonnet (Claude Code 2.1.251). Fact-checks with web lookups cost more.
- Run on its own docs before release, it found four real errors.

## What it can't do

It can't judge whether a review was any good. It records that one happened, on which version, against which checklist and by whom. It also can't stop someone who sets out to forge a review: the ledger catches hand edits, but anyone can record a review with made-up evidence, and that shows up in git history. It works on files in git, and the automatic review and the reviewer itself use Claude Code. The commit check and the CI check work whatever edited the file.

## Where teams use it

- Outreach sequences kept as Markdown or YAML templates. A checklist can ask for malformed personalisation tokens, claims the product can't back up, a missing opt-out line and anything that breaks your tone rules. Findings are flagged; set `blockOnFindings` on that pass if they should stop the commit as well.
- Battlecards and comparison pages, since competitors change pricing and features often. Give that pass a 30-day shelf life and web lookups.
- Blog posts that quote stats, prices and competitor features. A fact-check pass with web lookups checks them, and `maxAgeDays` makes every post due again after a set time.
- Pricing pages, landing pages and case studies, checked against one file of approved claims and customer quotes, such as `data/approved-claims.md`. The checklist tells the reviewer to report any figure, price or quote the page uses that the file doesn't contain. review-seal hashes only the page and the checklist, so editing that file doesn't send pages back for review. If it should, put the list in the checklist itself.
- Docs and help centers. A consistency pass flags a page that contradicts itself or another page, and a fact-check pass checks the product details.

[examples/gtm](examples/gtm) is a complete working GTM setup: an outreach pass that blocks on findings, a battlecard pass with a 30-day shelf life, a blog fact-check pass with a 90-day one, their checklists, an approved-claims file and sample pages with planted problems.

A checklist only needs to say what to look for. review-seal tells the reviewer how to format its answer.

For content held in a SaaS tool, such as a CMS or a sequencing tool, export or sync a copy to a path in the repository, such as `sequences/`, and point a pass at that path. review-seal only sees files in git.

## Install

Needs Node 20 or later, git 2.24 or later, and [Claude Code](https://code.claude.com/docs) installed and signed in.

    npm install -D review-seal
    npx review-seal init          # .seal/config.json, a starter checklist, an empty ledger
    npx review-seal install-hook  # git hooks and the ledger merge driver

`init` covers `docs/**/*.md` with one pass called `review`. Point `files` at what needs review. Globs are relative to the repository root, so in a monorepo write `packages/site/docs/**/*.md`. Commit `.seal/`: the ledger in it is your review history.

Each teammate's clone needs the hook too. Add this to the `scripts` in `package.json` so `npm install` sets it up:

    "prepare": "review-seal install-hook"

Then add the Claude Code plugin so reviews run on their own:

    /plugin marketplace add oo-pibe/review-seal
    /plugin install review-seal@review-seal

Reviews use the `claude` command you already have, signed in as you. Each one is a short headless session that can only read (Read, Grep, Glob, plus web lookups if a pass turns them on). A file is reviewed again only when it or its checklist changes, or when its review expires.

To try it without installing anything, see [example/README.md](example/README.md) (two minutes).

## A normal day

1. Claude edits `sequences/q4-reengage.yaml`. The plugin tells it the file needs a review.
2. Claude finishes its turn. The reviewer starts in the background, and the session doesn't wait.
3. The verdict lands in `.seal/ledger.json`. On your next message, Claude sees any findings, or a one-line note that the review came back clean.
4. You commit. The hook checks every staged covered file against the ledger and blocks any whose review is missing or out of date. The git hook from `install-hook` stages the reviews for that commit's files itself.

`review-seal list` shows every covered file and the state of each pass: `fresh`, `STALE`, `EXPIRED` or `never reviewed`. To review a file right away from Claude Code, use `/review-seal:review sequences/q4-reengage.yaml`.

## Adopting on an existing repo

Start with a dry run. It lists every file and pass a full run would review, and the totals, without spending anything:

    npx review-seal review --dry-run --all

Multiply the number of reviews it lists by what one costs you (cents for a consistency pass on a guide-length page, more with web lookups) before you run `review --all`. I'd start with one pass over the pages that matter most and widen the globs later.

Editing a checklist makes every review in that pass out of date, so plan to re-run the whole pass after each checklist change. Expiry recurs too: with `maxAgeDays: 30`, every page in that pass is due again each month, so budget for it or run `review --due` on a schedule (see [docs/reference.md](docs/reference.md#keeping-pages-current)).

## Why I built it

I run [Road to Kickoff](https://roadtokickoff.com), football travel guides. Agents draft and research, and nothing ships without review passes. review-seal is how I make sure those passes happen. Each rule in it closes a gap I found in that process.

Two of the passes printed a reminder and exited successfully whether or not anyone ran them, so nothing showed whether they had run. That gap let a Flamengo guide contradict itself on tickets: it said visitors needed a Brazilian tax number (CPF), then described uploading a passport. The passes now block, and each one is recorded against the version it read.

My old edit hook matched `Write|Edit`. Agents also change files through shell commands, and in auto mode they often prefer to: one turn edited files through a Python heredoc and the hook never fired. review-seal watches Bash commands too, and checks the working tree when Claude finishes.

Reviews by the person who built a piece missed problems that an outside reader then caught before publishing. Here the reviewer starts with no view of the conversation, and the ledger records whether each review was independent. Set `independentFrom` and the builder's own reviews stop counting from that date.

This repository reviews its own docs. A `claims` pass checks `README.md`, `SECURITY.md`, `example/README.md` and `docs/reference.md` against the code, and a `facts` pass checks what `README.md` and `SECURITY.md` say about Claude Code, git, GitHub Actions and pre-commit against their current documentation. The reviews are in [.seal/ledger.json](.seal/ledger.json).

## Commands

    review-seal init                        set up .seal/ in this repo
    review-seal review <files…> | --changed-since <ref>
                                            run the independent reviewer on those files if they need it
                                            (never reviewed, changed since, or past their shelf life)
    review-seal review --all                every covered file that changed or was never reviewed; ignores shelf life
    review-seal review --due                like --all, and also renews reviews past their shelf life
    review-seal review … --json <file>      also write what the run did (verdicts, failures) as JSON
    review-seal review … --dry-run          list what would be reviewed, and review nothing
    review-seal check [--staged | --changed-since <ref> | <files…>]
                                            exit 1 if a covered file lacks a fresh review
    review-seal list                        every covered file and its review status
    review-seal prune                       remove ledger entries for files that are gone or no longer covered
    review-seal seal <file> --pass <p> --reviewer builder --verdict clean|findings [--finding "…"]
    review-seal seal <file> --pass <p> --reviewer independent --evidence <verdict.json>
                                            record a review by hand
    review-seal install-hook [--force]      add the git pre-commit and pre-merge-commit hooks
    review-seal hash <file>                 print a file's content hash
    review-seal ledger-path                 print the ledger's path from the config

Configuration, CI, branches, limits and the ledger format: [docs/reference.md](docs/reference.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and what the reviewer can reach.

## License

MIT
