import { createHash } from 'node:crypto';

// Whitespace-only edits should not cost a review; any change to the words should.
export function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

export function contentHash(text) {
  return 'sha256:' + createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}

// Binds the review's evidence AND the version reviewed. Hand-editing any field breaks it.
// It is not a signature: anyone can recompute it. It catches edits, not forgery.
export function computeToken(file, pass, e) {
  const canonical = JSON.stringify({
    file,
    pass,
    at: e.at,
    contentHash: e.contentHash,
    rubricHash: e.rubricHash,
    verdict: e.verdict,
    findings: [...(e.findings || [])].map(String).sort(),
    reviewer: e.reviewer,
    via: e.via,
  });
  return 'rv_' + createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
