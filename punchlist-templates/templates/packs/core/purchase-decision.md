---
name: purchase-decision
kind: template
domain: general
inputs:
  - name: item
    exemplar: "a dehumidifier for a damp basement workshop, ~40 m²"
  - name: budget
    exemplar: "$250 max, prefer under $200"
  - name: requirements
    exemplar: "continuous drain hose option, auto-restart after power cut, quiet enough to run while working"
output: markdown
tags: [purchase, decision, research]
---
## Purpose

A purchase decision compares a SHORT list of real, buyable options
against the stated requirements and commits to one. It differs from a
research brief: the question is settled ("we are buying an X"), so the
work is scoring candidates, not framing the problem. Exactly three
options unless the requester said otherwise; a comparison table is
mandatory; "none of these — here's why" is a legitimate recommendation.

## Output shape

```markdown
# Purchase decision: <item>

**Budget:** the limit, and what "all-in" includes (accessories, shipping).
**Requirements:** the must-haves, each labeled MUST or NICE.

## Options
One paragraph per option (exactly 3 unless told otherwise): model,
street price, where it's sold, and the one thing that distinguishes it.

## Comparison
| Criterion | Option A | Option B | Option C |
|---|---|---|---|
Rows: price all-in, then every MUST, then the deciding NICE-to-haves,
then warranty/support. Cells are facts with units, not adjectives.
MUST failures are marked plainly (e.g. "no — deal-breaker").

## Recommendation
The pick, in bold, with the two or three facts that decided it. Note
the runner-up and the single condition that would flip the decision.
If nothing passes all MUSTs, say "buy nothing yet" and name what to
wait for.

## Caveats
- 1–3 bullets: price volatility, unverified specs, return-window notes.
```

## Golden exemplar

# Purchase decision: dehumidifier for the basement workshop

**Budget:** $250 max all-in (unit + drain hose), prefer under $200.
**Requirements:** continuous-drain hose option (MUST), auto-restart
after a power cut (MUST), ≤ 50 dB on low (NICE), 20 L/day or better
extraction (NICE).

## Options
- **Meaco Arete One 20L** — ~$220. Quietest 20 L-class unit in current
  reviews; hose port behind a snap cover; sold direct and via big-box
  stores. Distinguisher: 35–40 dB on low.
- **Midea Cube 20** — ~$180. Stacking bucket design doubles water
  capacity when extended; hose adapter included. Distinguisher: runs
  hose-free longer if the drain ever clogs.
- **Pro Breeze 12L** — ~$130. Cheapest with a hose port; compact.
  Distinguisher: price, at the cost of extraction rate.

## Comparison
| Criterion | Meaco Arete 20L | Midea Cube 20 | Pro Breeze 12L |
|---|---|---|---|
| Price all-in | $228 (hose incl.) | $186 + $9 hose | $134 + $9 hose |
| Continuous drain (MUST) | yes, gravity | yes, gravity | yes, gravity |
| Auto-restart (MUST) | yes | yes | **no — deal-breaker** |
| Noise on low (NICE ≤50 dB) | 37 dB | 46 dB | 42 dB |
| Extraction @ 30°C/80% (NICE ≥20 L) | 20 L/day | 20 L/day | 12 L/day |
| Warranty | 2 yr (5 on registration) | 1 yr | 1 yr |

## Recommendation
**Midea Cube 20, ~$195 all-in.** It passes both MUSTs, matches the
Meaco's extraction for $33 less, and the extendable bucket is genuine
insurance for a basement where a hose run may be awkward. Runner-up:
Meaco Arete One — it flips the decision if the workshop doubles as a
quiet hobby room, since 37 dB vs 46 dB is clearly audible over bench
work pauses. The Pro Breeze fails the auto-restart MUST; in a basement
that loses power unnoticed, that alone disqualifies it.

## Caveats
- Extraction figures are manufacturer numbers at 30°C/80% RH; expect
  roughly half that in a 15°C basement — true for all three equally.
- Midea's 1-year warranty is the weakest; check the retailer's return
  window before buying.
- Prices checked 2026-03; the Meaco fluctuates $200–240 seasonally.
