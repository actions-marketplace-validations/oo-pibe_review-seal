// Text that came from a reviewer or from a repository (findings, ledger fields, file names, checklist paths,
// reviewer errors) is untrusted. It is passed through sanitizeText before it is stored or shown, so it cannot
// drive a terminal (ANSI and OSC escapes), reorder what a reader sees (bidi overrides), or split into extra
// lines that a CI runner would read as its own commands.

// Tabs and line breaks become spaces, so a finding stays on one line.
const BREAKS = /[\t\n\r\u2028\u2029]/g;
// Every other C0 control, DEL, every C1 control, and the bidi embedding, override and isolate characters.
const STRIP = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeText(s) {
  return String(s ?? '').replace(BREAKS, ' ').replace(STRIP, '');
}
