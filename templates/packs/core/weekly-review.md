---
name: weekly-review
kind: template
domain: personal
inputs:
  - name: week_notes
    exemplar: "raw bullet notes from the week — done items, half-thoughts, links, complaints, e.g. 'shipped the invoice fix / gym x2 / still no reply from the landlord / that podcast on sleep'"
  - name: last_week_focus
    exemplar: "the 'Next week's focus' list from the previous review, e.g. '1. finish the garage shelving 2. book the dentist 3. draft the blog post'"
output: markdown
tags: [review, writing, personal]
---
## Purpose

Turn a week's raw notes into a short, honest review a person would
actually reread: what worked, what didn't, what it taught, and a small
concrete focus list for next week. It closes the loop on last week's
focus — every item there gets a verdict, even if the verdict is
"dropped it, on purpose."

## Output shape

```markdown
# Weekly review — <week of YYYY-MM-DD>

## Wins
- 3–6 bullets. Concrete things that happened, not virtues. Include the
  small ones — "finally emptied the inbox" counts.

## Where I got stuck
- 2–4 bullets. Name the blocker honestly (waiting on someone, avoided
  it, underestimated it). No self-flagellation, just the mechanism.

## Last week's focus — verdict
- One line per item from last week's focus: **done**, **partial**
  (what's left), or **dropped** (why that's fine or not).

## Lessons
- 1–3 bullets. Only lessons the week actually taught; skip the section
  header's worth of filler if there's just one.

## Next week's focus
1. At most three items, each startable on Monday and checkable by
   Friday. Verbs first.
```

Keep the whole thing under ~300 words. If a section would be empty,
write one honest line rather than inventing content.

## Golden exemplar

# Weekly review — week of 2026-03-09

## Wins
- Shipped the export-to-CSV feature that had been "almost done" for two
  weeks — cutting the scope to just the orders table is what unblocked it.
- Ran three times (Tue/Thu/Sat), first full week back since the ankle.
- Cleared the garage workbench; the drill press finally has a home.
- Called the accountant instead of re-reading the tax letter a fourth time.

## Where I got stuck
- The insurance claim needs a document I can't find; spent 40 minutes
  digging, then avoided it the rest of the week. Blocker is a phone
  call, not a search.
- Tuesday and Wednesday evenings evaporated into video. No plan for the
  evening = default to the couch.

## Last week's focus — verdict
- Ship CSV export — **done**.
- Book the dentist — **done** (April 2nd).
- Outline the workshop talk — **dropped**: the deadline moved to June;
  parking it until May is fine.

## Lessons
- "Almost done" for more than a week means the scope is wrong, not the
  effort.
- The insurance thing shows the pattern again: when I'm stuck, the next
  step is usually a person, not more searching.

## Next week's focus
1. Call the insurer Monday morning and ask what replaces the missing
   document.
2. Plan Tuesday and Thursday evenings on Sunday (anything, as long as
   it's chosen).
3. Do the first ride-along run of the 10k plan.
