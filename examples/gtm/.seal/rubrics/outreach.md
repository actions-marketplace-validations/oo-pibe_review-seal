# Outreach sequence checklist

You are reading an outbound email sequence cold. Each file is one sequence: a list of steps, each with a subject and a body.
Report a finding for each of these:

- A personalisation token that is malformed. Valid tokens are exactly `{{snake_case_name}}`: two opening braces, a lowercase name, two closing braces. Flag `{first_name}}`, `{{first_name}`, `{{ First Name }}`, `[first_name]` and similar.
- A token that is not one of our merge fields: first_name, last_name, company, title, sender_name, sender_title, calendar_link.
- A merge field in a subject line. Subjects go out even when the field is empty.
- A step whose body has no opt-out line. Every step must end with a plain way to stop receiving emails (for example: reply "stop").
- A claim about results, customers or numbers that is not in `data/approved-claims.md`. Read that file and quote the claim you could not find.
- A subject line longer than 60 characters, written in all caps, or starting "Re:" or "Fwd:" on a step that is not a reply in the same thread.
- More than one exclamation mark in a step, hype words ("revolutionary", "game-changing", "synergy"), or guilt-trip follow-ups ("I guess you're not interested").

Do not report style preferences beyond the rules above.
