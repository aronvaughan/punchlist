'use strict';
// effort-events.js — the append-only ledger for an EFFORT, at
// process/efforts/<slug>/events.jsonl.
//
// A run ledger records what one card did. An effort ledger records what the
// orchestrator did ABOVE the cards: what a subagent asked, what the brain
// decided alone, what it refused to decide, which cards a wave dispatched, and
// when a human gate closed and reset the brain's authority.
//
// It is NOT the effort YAML's `decisions:`. Those are curated and human-shaped
// (settled / recorded-wrong); these are machine-generated, append-only and
// high-volume. Conflating them would make a hand-edited file a hot write path.
//
// The write discipline is the requirement, not an aspiration, and it is the
// same discipline run ledgers already hold themselves to:
//
//   - every write holds the effort's exclusive lock (lib/locking withLock);
//   - the lock spans the READ as well as the write, because an event's id comes
//     from the ledger's length — two writers that both read first would take the
//     same id;
//   - a torn trailing line (a crash mid-append) is dropped before appending, so
//     one bad line never poisons the ledger;
//   - a reader that will later write remembers a hash of what it read, and the
//     write refuses when the file changed underneath it. A lost update becomes a
//     refusal.
//
// The generic half lives here on purpose. lib/spine.js has the run-ledger copy;
// pointing it at `appendTo`/`readFrom` is the next task's job (its file, its
// card). Until then this is the single implementation to change, not a fork —
// the duplication is recorded rather than quietly accepted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const locking = require('./locking');

// ---- generic ledger primitives (run OR effort) -----------------------------

const READ_HASH = Symbol('events.jsonl hash at read');
function textHash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function remember(arr, text) {
  Object.defineProperty(arr, READ_HASH, { value: textHash(text), enumerable: false, writable: true, configurable: true });
}

// readFrom(dir) -> events[]. The array carries a hidden hash of the exact bytes
// read, which appendTo compares under the lock.
// readFrom ALWAYS remembers the bytes it read, exactly as spine.readState does.
// It used to be opt-in, which made the lost-update protection opt-in TWICE — the
// reader had to ask, and the writer had to be handed the result — and forgetting
// either half failed silently, so a lost update looked like a successful write.
function readFrom(dir) {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) {
    const empty = [];
    remember(empty, '');
    return empty;
  }
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch (err) {
      // Only the LAST line may be torn — a crash mid-append. Anywhere else means
      // the ledger is corrupt, and guessing which half is real is worse than stopping.
      if (i === lines.length - 1) continue;
      throw new Error(`corrupt event ledger at ${file}: unparsable line ${i + 1}`);
    }
  }
  remember(out, text);
  return out;
}

// appendTo(dir, event, { expect }) -> the full event as written.
// `expect` is an array previously returned by readFrom; when given, the append
// refuses if the file changed since that read.
// `event` may be an object, or a function (events) => object evaluated UNDER the
// lock. Anything derived from the ledger's own contents — the gate epoch, say —
// must be computed there: read it outside and another writer can move it before
// the append lands, which is the same race the id already guards against.
// `verify(written)` is called with the line as it will EXIST ON DISK — serialized and
// parsed back — not with the object that produced it. Those differ: an own `toJSON` or a
// getter that answers differently on a second read makes the input and the bytes two
// different things, and a guard that reads the input is guarding the wrong one. Round
// four found exactly that hole after three rounds of guarding inputs.
// `stamp` names the extra envelope keys THIS ledger owns, with their values — a run ledger stamps
// `run`, the effort ledger stamps `effort` and `gate_epoch`. They are treated exactly as `id` and
// `ts` are: refused if the caller supplies one, and applied AFTER the spread so a key that slipped
// the check still cannot erase the envelope. Passing them here rather than guarding at each call
// site is the whole point of one writer — a second guard written beside a second envelope is how
// these two drifted apart in the first place.
// `at` back-dates the event, for the two callers that legitimately choose a timestamp: a fixture
// building a ledger at known times, and an import of history that already happened. It is a
// separate ARGUMENT, not a key, which is the whole distinction this change turns on — the defect
// was `ts` winning silently by spread order from inside a caller's data, and no spread can ever
// produce an option. A `ts` key on the event is still refused by name.
function appendTo(dir, event, { expect, verify, stamp = {}, at } = {}) {
  if (event === null || (typeof event !== 'object' && typeof event !== 'function')) {
    throw new Error('appendTo needs an event object or a builder function');
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  return locking.withLock(dir, () => {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (expect !== undefined) {
      const was = expect[READ_HASH];
      // A caller that passes `expect` is asking to be protected. An array with no
      // hash cannot protect them, so say so rather than proceed unprotected — the
      // silent version of this check is what let a lost update through.
      if (was === undefined) throw new Error('expect: that array was not read from this ledger — pass what readFrom returned');
      if (textHash(now) !== was) {
        throw new Error(`events.jsonl in ${dir} changed since it was read — re-read and retry`);
      }
    }
    // A truncated trailing line (a crash mid-append) is dropped rather than preserved. Run
    // ledgers had this repair and effort ledgers did not, which is the kind of difference that
    // exists only because two writers were written at different times. It runs AFTER the `expect`
    // check above, deliberately: the caller's expectation is about the bytes they actually read,
    // torn tail included, and repairing first would let a stale expectation pass.
    if (now) {
      const raw = now.split('\n').filter(Boolean);
      const last = raw[raw.length - 1];
      let ok = last === undefined;
      if (!ok) { try { JSON.parse(last); ok = true; } catch (err) { ok = false; } }
      if (!ok) locking.writeFileAtomic(file, raw.slice(0, -1).map((l) => l + '\n').join(''));
    }
    const existing = readFrom(dir);
    const n = existing.length + 1;
    const body = typeof event === 'function' ? event(existing) : event;
    // The envelope is the writer's, never the caller's. `{ id, ts, ...body }` let a
    // caller override both by spread order — replaying a previously-read event into
    // another ledger produced a duplicate id, silently. Refused rather than
    // overwritten: a caller passing `id` is replaying, and renumbering hides that.
    // Object.hasOwn, not `!== undefined`: spread copies the KEY, so `{...read, id:
    // undefined}` — the natural strip-the-envelope-and-replay idiom — passed a value
    // check and then spread an own `id: undefined` over the stamped one. The line went
    // to disk with NO id, the next append skipped a number, and the ledger failed its
    // own schema. Checking the value was the wrong test for a spread.
    for (const k of ['id', 'ts', ...Object.keys(stamp)]) {
      if (Object.hasOwn(body, k)) throw new Error(`${k} is set by the ledger, not the caller`);
    }
    // Stamped AFTER the spread as well, so even a key that slipped the check cannot
    // erase the envelope. This is the shape `effort`/`gate_epoch` already used below —
    // using it in one place and not the other is what left the hole.
    const id = 'e' + String(n).padStart(6, '0');
    if (at !== undefined && !(typeof at === 'string' && !Number.isNaN(Date.parse(at)))) {
      throw new Error(`at must be an ISO timestamp string, got ${JSON.stringify(at)}`);
    }
    const ts = at !== undefined ? new Date(at).toISOString() : new Date().toISOString();
    const full = { ...body, ...stamp, id, ts };

    // Serialize ONCE, check what came out, then write those exact bytes. Writing a
    // second serialization would re-invoke any accessor and could differ from the one
    // that was checked — the same class of bug, one layer down.
    // Both halves in the try: a cycle throws at stringify, not at parse, and an
    // unhandled TypeError from inside the writer tells the caller nothing about why.
    let line, written;
    try {
      line = JSON.stringify(full);
      written = JSON.parse(line);
    } catch (err) {
      throw new Error(`event does not serialize to JSON: ${err.message.split('\n')[0]}`);
    }
    if (written === null || typeof written !== 'object' || Array.isArray(written)) {
      throw new Error('event must serialize to a JSON object');
    }
    for (const [k, v] of Object.entries(stamp)) {
      if (written[k] !== v) throw new Error(`${k} is set by the ledger, not the caller`);
    }
    if (written.id !== id || written.ts !== ts) {
      throw new Error('id and ts are set by the ledger, not the caller');
    }
    if (verify) verify(written);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      let ok = last === undefined;
      if (!ok) { try { JSON.parse(last); ok = true; } catch (err) { ok = false; } }
      if (!ok) locking.writeFileAtomic(file, lines.slice(0, -1).map((l) => l + '\n').join(''));
    }
    fs.appendFileSync(file, line + '\n');
    // Re-point the caller's hash at what they now hold, so a caller batching several
    // appends under one read is not refused for its own writes. spine.writeState does
    // the same after a successful write; diverging from it was an unrecorded drift.
    if (expect !== undefined) remember(expect, fs.readFileSync(file, 'utf8'));
    return full;
  });
}

// ---- effort ledger ---------------------------------------------------------

// The kinds an EFFORT ledger may carry. Deliberately a short, closed list: an
// event nobody reads is a receipt that silently does nothing, and the decision
// log is the one place where a missing line is indistinguishable from a decision
// that was never made.
const EFFORT_KINDS = Object.freeze(['ask', 'decision', 'escalation', 'blocked', 'wave', 'epoch', 'pane']);
const WHO = Object.freeze(['fan', 'brain', 'gate']);

// checkSlug lives HERE, not in each caller: readEffortEvents used to skip it, so
// readEffortEvents(p, '../runs/R1') returned a RUN ledger's lines as effort events.
// Every path to the directory goes through this function, so this is the chokepoint.
function effortDir(processDir, slug) { checkSlug(slug); return path.join(processDir, 'efforts', slug); }

function readEffortEvents(processDir, slug) {
  return readFrom(effortDir(processDir, slug));
}

// A slug names a directory, so it must not be able to name a DIFFERENT one. Without
// this, appendEffortEvent(p, '../runs/R1', …) writes into a run ledger's directory —
// the effort writer reaching into the run writer's storage, silently.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error(`effort slug ${JSON.stringify(slug)} must be letters, digits, dot, dash or underscore`);
  }
}

// appendEffortEvent — the one call every effort writer goes through, so a
// kindless or misspelt event cannot be written from any call site. The guard
// lives here rather than in each caller for the reason the run ledger learned
// the hard way: a guard in one writer is a guard the other writers walk past.
function appendEffortEvent(processDir, slug, event, opts) {
  if (!event || !event.kind) throw new Error('an effort event needs a kind: ' + JSON.stringify(event));
  if (!EFFORT_KINDS.includes(event.kind)) {
    throw new Error(`effort event kind ${event.kind} is not one of: ${EFFORT_KINDS.join(', ')}`);
  }
  // `who` is REQUIRED, not merely checked when present. A decision with no
  // authority is a line that cannot answer the only question the log exists to
  // answer — who decided this. A typo was already refused; an omission was not,
  // which is the wrong way round.
  if (!WHO.includes(event.who)) {
    throw new Error(`an effort event needs who (${WHO.join(' | ')}), got ${JSON.stringify(event.who)}`);
  }
  if (event.effort !== undefined) {
    throw new Error('effort is set by the ledger, not the caller');
  }
  if (event.run !== undefined) {
    // Exactly one of run/effort is what tells a reader which ledger a line came
    // from; the schema enforces it, and so does the writer.
    throw new Error('an effort event carries `effort`, never `run`');
  }
  // gate_epoch is stamped HERE, from the ledger, under the lock — never trusted from
  // the caller and never read outside it. A decision written without one escaped
  // decisionsThisEpoch entirely, which is the brain's own call escaping the review
  // that exists to catch it: the worst failure this file has. A caller may state the
  // epoch it believes it is in, and a disagreement is refused rather than silently
  // corrected, because believing the wrong epoch means the caller read stale state.
  return appendTo(effortDir(processDir, slug), (events) => {
    const epoch = events.filter((e) => e.kind === 'epoch').length;
    if (event.gate_epoch !== undefined && event.gate_epoch !== epoch) {
      throw new Error(`gate_epoch ${JSON.stringify(event.gate_epoch)} disagrees with the ledger's ${epoch} — re-read and retry`);
    }
    return { ...event, effort: slug, gate_epoch: epoch };
  }, {
    ...opts,
    // The same check, for the fields this ledger owns. Guarding the input caught the
    // ordinary mistakes; guarding the bytes catches the rest, and costs one parse.
    verify(written) {
      if (written.effort !== slug) throw new Error('effort is set by the ledger, not the caller');
      if (written.run !== undefined) throw new Error('an effort event carries `effort`, never `run`');
      if (!EFFORT_KINDS.includes(written.kind)) throw new Error(`effort event kind ${written.kind} is not one of: ${EFFORT_KINDS.join(', ')}`);
      if (!WHO.includes(written.who)) throw new Error(`an effort event needs who (${WHO.join(' | ')}), got ${JSON.stringify(written.who)}`);
      if (!Number.isInteger(written.gate_epoch)) throw new Error('gate_epoch is set by the ledger, not the caller');
    },
  });
}

// The brain's authority resets when a human gate closes. gateEpoch is the count
// of closed gates: every decision records the epoch it was made in, so "what did
// it decide on its own since I last looked" is a filter, not a judgement.
function gateEpoch(processDir, slug) {
  return readEffortEvents(processDir, slug).filter((e) => e.kind === 'epoch').length;
}

// Decisions the brain made alone in the current epoch — what the next human gate
// has to review. Ordered as written.
function decisionsThisEpoch(processDir, slug) {
  const epoch = gateEpoch(processDir, slug);
  return readEffortEvents(processDir, slug)
    // Strict equality on a stamped integer: every line now carries one, so a line
    // without it is a line this writer did not produce, and guessing its epoch would
    // put a foreign decision in front of a human as though the brain had made it.
    .filter((e) => e.kind === 'decision' && e.who === 'brain' && e.gate_epoch === epoch);
}

module.exports = {
  readFrom, appendTo,
  readEffortEvents, appendEffortEvent,
  gateEpoch, decisionsThisEpoch,
  effortDir, EFFORT_KINDS, WHO,
};
