# Try review-seal in two minutes

`docs/tickets.md` contradicts itself on purpose: one line says you need a local tax number, the next says a passport works instead.

You need Node 20 or later, git 2.24 or later, and Claude Code installed and signed in. From a checkout of this repository:

    RS="$PWD/bin/review-seal.js"
    rs() { node "$RS" "$@"; }      # once published: rs() { npx review-seal "$@"; }
    rm -rf /tmp/rs-demo && cp -r example /tmp/rs-demo && cd /tmp/rs-demo
    git init -q && git add -A
    rs install-hook
    git commit -m "try"            # refused: never reviewed
    rs review docs/tickets.md docs/getting-there.md
    rs list                        # each file's verdict, recorded as independent
    git add -A && git commit -m "try again"   # goes through; open findings print as FLAG lines

Each review usually takes under a minute. With the plugin installed you never run `review` yourself: edit a file in a Claude Code session and the review runs when Claude finishes its turn.
