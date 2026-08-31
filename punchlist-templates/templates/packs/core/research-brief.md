---
name: research-brief
kind: template
domain: general
inputs:
  - name: topic
    exemplar: "a label printer for home organizing — jars, cable bins, filing"
  - name: constraints
    exemplar: "under $150, must work without a phone app, tape refills easy to buy"
output: markdown
tags: [research, writing]
---
## Purpose

A research brief answers ONE question well enough that the reader can
decide without redoing the research. It is not a survey of everything
found — it is the found things ranked, compressed, and honest about
uncertainty. If the research changed the question, say so at the top.

## Output shape

```markdown
# Research brief: <topic>

**Question:** one sentence — what decision this research serves.
**Constraints:** the hard limits given (budget, must-haves, deal-breakers).

## TL;DR
2–4 sentences: the answer, the strongest alternative, and the one thing
that would change the answer.

## Options surveyed
One short paragraph or 2–3 bullets per option (3–5 options max):
what it is, why it made the list, the headline number(s). Name the
options that were considered and cut, in one line.

## Key findings
- 4–8 bullets of facts that drove the ranking — prices, limits,
  failure modes, recurring costs. Each finding cites its source inline.
- Flag anything load-bearing that could not be verified.

## Recommendation
The pick, the runner-up, and the condition under which the runner-up
wins instead. Concrete next step (what to buy/do, where).

## Sources
Numbered list. Retailer pages, manuals, reviews — with dates where
freshness matters.
```

## Golden exemplar

# Research brief: label printer for home organizing

**Question:** which label printer under $150 should we buy for labeling
jars, cable bins, and file folders?
**Constraints:** under $150 all-in; must work standalone (no phone-app
dependency); tape refills stocked at ordinary office-supply stores.

## TL;DR
Buy the Brother P-touch PT-D220 (~$45): standalone keyboard, uses the
ubiquitous TZe tape line, and refills are the cheapest per label of
anything surveyed. The runner-up DYMO LabelManager 280 has a nicer
rechargeable battery, but its D1 tapes cost ~40% more per meter and
peel worse on curved jars. The answer changes only if you need to print
from a computer — then step up to the PT-D460BT (~$80).

## Options surveyed
- **Brother PT-D220** — entry standalone unit; QWERTY keyboard, one-line
  and two-line printing, TZe laminated tapes (12mm max). ~$45 street.
- **DYMO LabelManager 280** — rechargeable li-ion, prints D1 tapes,
  slightly better screen. ~$65 street.
- **Brother PT-D460BT** — same TZe tapes, adds USB/Bluetooth printing
  and 18mm width. ~$80 street.
- Cut in round one: phone-app-only cube printers (violates standalone
  constraint) and thermal shipping-label units (wrong label type for
  jars and cables).

## Key findings
- TZe laminated tape survives dishwasher runs; D1 is not laminated and
  DYMO markets it for indoor dry use only [2][4].
- Refill cost per meter: TZe 12mm ~ $1.00/m generic, ~$1.90/m branded;
  D1 12mm ~ $2.60/m branded, generics scarce [1][3].
- Both Brother units take 6×AAA or an optional AC adapter (~$15, not in
  the box); the DYMO charges over micro-USB [2][4].
- The PT-D220 cannot print from a computer at all — labels are typed on
  the device. Confirmed in the manual, not just the listing [2].
- Unverified: several reviews claim generic TZe cartridges throw no
  errors on the D220; plausible (no chip in TZe) but not tested
  first-hand [5].

## Recommendation
**PT-D220**, plus one generic 3-pack of 12mm TZe tape and the AC
adapter — ~$70 all-in, well under budget. Runner-up **LabelManager
280** wins only if built-in recharging outweighs tape cost and jar
durability. Next step: order the D220 bundle from any office-supply
retailer; skip the branded starter tape.

## Sources
1. Office-supply retailer listings for TZe-231 3-packs, checked 2026-03.
2. Brother PT-D220 user manual (PDF), tape compatibility appendix.
3. DYMO D1 45013 retail pricing, checked 2026-03.
4. DYMO LabelManager 280 product page and manual.
5. Aggregated customer reviews on generic TZe compatibility (unverified).
