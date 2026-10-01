---
name: spike-note
kind: template
domain: engineering
inputs:
  - name: card
    exemplar: "TRK-42"
  - name: question
    exemplar: "Does a field workstation still reach the backend at print time, or must printing survive a partition?"
  - name: decision_id
    exemplar: "D-002"
output: markdown
tags: [spine, research, writing]
---
## Purpose

A spike note answers ONE question with evidence so the effort can record a decision and
stop paying for the uncertainty. It is not a survey: the answer first, the evidence that
supports it, what would change the answer, and the decision the owner is asked to record.
The owner edits this note on the page; their edits are final.

## Output shape

```markdown
# Spike: <question>

**Answer:** one or two sentences. State the confidence (high / medium / low) and why.

**Decision to record:** `<decision_id>` — the one-line ruling the effort file will carry.

## Evidence
- <finding> — <how it was established: a test, a doc, a measurement, a conversation> (link)
- …

## What would change the answer
- <condition> → <different answer>

## Consequences
- <what the effort does differently now: phases unblocked, cards re-sized, cards dropped>

## Not answered
- <adjacent question deliberately left open, and where it goes>
```

## Rules

- The answer is falsifiable and dated; "it depends" is a fail unless the dependency is named.
- Every evidence line says how it was established. An opinion is labelled as one.
- No internal ticket numbers in the body except the decision id and the card in the header.

## Golden exemplar

```markdown
# Spike: does a field workstation reach the backend at print time?

**Answer:** Yes, for every site in the pilot: the print path is online-only today and no site
reported a partition in six months of ticket history. Confidence high for the pilot, low for
sites we have not measured.

**Decision to record:** `D-002` — printing stays server-rendered; no client-side renderer in
phases 6–7.

## Evidence
- 0 partition incidents across 14 pilot sites, Jan–Jun — support ticket export, filtered on
  "offline" / "no connection" (link)
- The workstation image has no local print queue: a partition already blocks the sale itself,
  not only the receipt — imaging manifest, line 41 (link)
- One conversation, not a measurement: the site lead at the largest park said "if the network
  is down we close the window" (opinion, labelled)

## What would change the answer
- A site with a local sale queue → printing must survive a partition → cached template plus a
  client-side emit, the second renderer

## Consequences
- Phases 6 and 7 stop being provisional; the second-renderer card is dropped from the effort
- The offline card stays parked with this note as its only reference

## Not answered
- Whether the mobile ranger app prints at all — goes to the mobile effort
```
