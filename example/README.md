# Try review-seal in two minutes

`docs/tickets.md` contradicts itself on purpose: one line says you need a local tax number, the next says a passport works instead.

    cp -r example /tmp/rs-demo && cd /tmp/rs-demo
    git init -q && git add -A
    npx review-seal install-hook
    git commit -m "try"            # refused: never reviewed
    npx review-seal review docs/tickets.md docs/getting-there.md
    npx review-seal list           # the reviewer's findings, on the record
    git add -A && git commit -m "try again"

The review needs Claude Code installed and signed in. With the plugin installed, you never run `review` yourself: edit a file in a Claude Code session and the review runs when Claude finishes its turn.
