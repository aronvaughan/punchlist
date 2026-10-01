'use strict';
// validate — the workflow validator, and the `opts` its config and on-disk checks need.
//
// `validateWorkflow` used to live in bin/plt, and every CLI call site omitted `opts`, so the
// checks that read the project config (gate signals, jira statuses) and the
// skills and agents on disk never ran outside a test that supplied `opts` by hand. `buildOpts`
// builds it from a process directory, and every caller now passes it.
//
// bin/plt and lib/spine.js are required lazily, inside functions: lib/spine.js requires bin/plt
// at load time, and bin/plt requires this module, so a top-level require here would close the
// loop while bin/plt's exports are still empty.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Interpolation placeholders used in a string: {input_name}
// The run vars `renderBanners` substitutes into a `banner` (lib/spine.js, `const vars = …`).
const BANNER_VARS = ['run', 'card', 'pr_url', 'card_url'];

function placeholders(s) {
  const out = [];
  for (const m of String(s).matchAll(/\{([A-Za-z_][\w-]*)\}/g)) out.push(m[1]);
  return out;
}

// The step edges that participate in dependency cycles. on_fail.then and
// repeat_until are deliberately excluded — they are the sanctioned loops.
function depEdges(step) {
  const deps = [];
  if (Array.isArray(step.needs)) deps.push(...step.needs);
  if (step.when && typeof step.when === 'object' && step.when.step) deps.push(step.when.step);
  if (step.else_of) deps.push(step.else_of);
  return deps;
}

// Detect a dependency cycle over needs/when/else_of. Returns the cycle as
// an array of ids, or null. Unknown edge targets are ignored here — they
// are reported separately by the reference checks.
function findDependencyCycle(steps) {
  const ids = new Set(steps.map((s) => s.id));
  const deps = new Map(steps.map((s) => [s.id, depEdges(s).filter((d) => ids.has(d))]));
  const state = new Map(); // id -> 1 (visiting) | 2 (done)
  const stack = [];
  function visit(id) {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) || []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }
  for (const id of ids) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

// Validate a workflow file's parsed form. `templates` is a Set of known
// template names. `opts` (all optional) = { config, skillsOnDisk: Set,
// agentsOnDisk: Set } — when absent, the corresponding checks are skipped.
// Returns [{line, msg}].
function validateWorkflow(parsed, file, templates, opts = {}) {
  const { POLL_FACTS, normalizeGhName } = require('./spine');
  const { GH_FACT_NAMES } = require('./facts');
  const errors = [...parsed.errors];
  const { fm, fmLines, steps } = parsed;
  const at = (key) => (fmLines && fmLines[key]) || 1;

  const expectedName = path.basename(file, '.md');
  if (!fm.name) errors.push({ line: 1, msg: 'missing `name` in frontmatter' });
  // `kind` was never read here, so `effort`, `efort` and `banana` were equally accepted — the new
  // kind would have been tolerated rather than declared, which is indistinguishable from a typo
  // until something downstream behaves oddly. `workflow` runs once per CARD; `effort` runs once per
  // effort, above the cards.
  if (fm.kind !== undefined && !['workflow', 'effort'].includes(fm.kind)) {
    errors.push({ line: at('kind'), msg: `\`kind\` must be workflow|effort, not \`${fm.kind}\`` });
  }
  else if (fm.name !== expectedName) {
    errors.push({ line: at('name'), msg: `name \`${fm.name}\` does not match filename \`${expectedName}.md\`` });
  }
  // `index`/`run`/`all` are reserved for `plt render`'s board-page targets — a workflow named one
  // of these would be permanently unreachable through `plt render <name>` (shadowed by the board
  // page every time), so it is refused here rather than left as a silent trap.
  if (fm.name && ['index', 'run', 'all'].includes(fm.name)) {
    errors.push({ line: at('name'), msg: `name \`${fm.name}\` is reserved by \`plt render\` (index|run|all are board-page targets) — pick another name` });
  }

  if (!Array.isArray(fm.actors) || fm.actors.length === 0) {
    errors.push({ line: at('actors'), msg: 'workflow must declare `actors: [..]`' });
  }
  if (fm.inputs !== undefined &&
      (!Array.isArray(fm.inputs) || fm.inputs.some((i) => typeof i !== 'string' || !i.trim()))) {
    errors.push({ line: at('inputs'), msg: '`inputs` must be an inline list of names, e.g. `inputs: [item, budget]`' });
  }
  // `cards: external` means the run tracks work we do not own, so jira requirements never apply
  // (lib/spine.js#externalCards). Nothing else is a value: `externalCards` swallows its own errors,
  // so an unvalidated typo (`extenal`) would silently restore the jira requirements a formula
  // meant to drop, with no message anywhere.
  if (fm.cards !== undefined && fm.cards !== 'external') {
    errors.push({ line: at('cards'), msg: `\`cards: ${fm.cards}\` must be \`external\` (the only value) or absent` });
  }
  const inputs = new Set(Array.isArray(fm.inputs) ? fm.inputs : []);
  const actors = new Set(Array.isArray(fm.actors) ? fm.actors : []);

  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push({ line: parsed.bodyStart || 1, msg: 'workflow must have a body-level `steps:` block with at least one step' });
    return errors;
  }

  const ids = new Set();
  for (const s of steps) {
    const line = s.__line || 1;
    if (!s.id || typeof s.id !== 'string') {
      errors.push({ line, msg: 'step is missing `id`' });
      continue;
    }
    if (ids.has(s.id)) errors.push({ line, msg: `duplicate step id \`${s.id}\`` });
    ids.add(s.id);
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ref = (s, field, target) => {
    if (!byId.has(target)) {
      errors.push({ line: s.__line || 1, msg: `step \`${s.id}\`: ${field} references unknown step \`${target}\`` });
      return false;
    }
    if (target === s.id) {
      errors.push({ line: s.__line || 1, msg: `step \`${s.id}\`: ${field} references itself` });
      return false;
    }
    return true;
  };
  const outcomesOf = (id) => {
    const t = byId.get(id);
    return t && Array.isArray(t.outcomes) ? t.outcomes : ['done'];
  };

  for (const s of steps) {
    if (!s.id) continue;
    const line = s.__line || 1;

    if (!s.assignee || typeof s.assignee !== 'string') {
      errors.push({ line, msg: `step \`${s.id}\` is missing \`assignee\`` });
    } else if (actors.size > 0 && !actors.has(s.assignee)) {
      errors.push({ line, msg: `step \`${s.id}\`: assignee \`${s.assignee}\` is not in the declared actors` });
    }

    if (s.template !== undefined) {
      if (typeof s.template !== 'string' || !templates.has(s.template)) {
        errors.push({ line, msg: `step \`${s.id}\`: template \`${s.template}\` does not exist (plt list --kind template)` });
      }
    }

    if (s.outcomes !== undefined) {
      if (!Array.isArray(s.outcomes) || s.outcomes.length === 0 ||
          s.outcomes.some((o) => typeof o !== 'string' || !o.trim())) {
        errors.push({ line, msg: `step \`${s.id}\`: \`outcomes\` must be a nonempty inline list of names` });
      } else if (new Set(s.outcomes).size !== s.outcomes.length) {
        errors.push({ line, msg: `step \`${s.id}\`: \`outcomes\` has duplicates` });
      }
    }

    if (s.needs !== undefined) {
      if (!Array.isArray(s.needs) || s.needs.length === 0) {
        errors.push({ line, msg: `step \`${s.id}\`: \`needs\` must be an inline list of step ids` });
      } else {
        for (const n of s.needs) ref(s, 'needs', n);
      }
    }

    if (s.when !== undefined) {
      if (typeof s.when !== 'object' || Array.isArray(s.when) || !s.when.step || !s.when.outcome) {
        errors.push({ line, msg: `step \`${s.id}\`: \`when\` must be \`{ step: <id>, outcome: <name> }\`` });
      } else if (ref(s, 'when', s.when.step)) {
        if (!outcomesOf(s.when.step).includes(s.when.outcome)) {
          errors.push({ line, msg: `step \`${s.id}\`: \`when\` outcome \`${s.when.outcome}\` is not a declared outcome of \`${s.when.step}\`` });
        }
      }
    }

    if (s.else_of !== undefined) {
      if (typeof s.else_of !== 'string') {
        errors.push({ line, msg: `step \`${s.id}\`: \`else_of\` must be a step id` });
      } else if (ref(s, 'else_of', s.else_of)) {
        const siblings = steps.filter((x) => x.when && typeof x.when === 'object' && x.when.step === s.else_of);
        if (siblings.length === 0) {
          errors.push({ line, msg: `step \`${s.id}\`: \`else_of: ${s.else_of}\` but no step has a \`when\` branch on \`${s.else_of}\`` });
        }
      }
    }

    if (s.on_fail !== undefined) {
      if (typeof s.on_fail !== 'object' || Array.isArray(s.on_fail)) {
        errors.push({ line, msg: `step \`${s.id}\`: \`on_fail\` must be \`{ retry: N, then: <id> }\`` });
      } else {
        if (s.on_fail.retry !== undefined && !/^\d+$/.test(String(s.on_fail.retry))) {
          errors.push({ line, msg: `step \`${s.id}\`: \`on_fail.retry\` must be a non-negative integer` });
        }
        if (s.on_fail.then !== undefined) ref(s, 'on_fail.then', s.on_fail.then);
        for (const k of Object.keys(s.on_fail)) {
          if (!['retry', 'then'].includes(k)) {
            errors.push({ line, msg: `step \`${s.id}\`: unknown \`on_fail\` key \`${k}\`` });
          }
        }
      }
    }

    if (s.repeat_until !== undefined) {
      if (typeof s.repeat_until !== 'string' || !s.repeat_until.trim()) {
        errors.push({ line, msg: `step \`${s.id}\`: \`repeat_until\` must be an outcome name` });
      } else if (!Array.isArray(s.outcomes)) {
        errors.push({ line, msg: `step \`${s.id}\`: \`repeat_until\` requires the step to declare \`outcomes\`` });
      } else if (!s.outcomes.includes(s.repeat_until)) {
        errors.push({ line, msg: `step \`${s.id}\`: \`repeat_until: ${s.repeat_until}\` is not one of the step's outcomes` });
      }
    }

    // ---- process-spine keys (all optional; validated when present) ----
    const cfg = opts.config || {};
    const listOfNames = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim());
    // Keys this validator once checked and no runtime path ever read. A key that
    // validates and does nothing reads as enforcement, so each is now an error. `on_fail` is the
    // one exception: it still validates, and is not yet executed.
    const dead = (key) => errors.push({ line, msg: `step \`${s.id}\`: key \`${key}\` is not read by anything, so it has no effect — remove it` });
    for (const k of ['model', 'reasoning']) if (s[k] !== undefined) dead(k);
    // `lands` / `checks_drift` declare BEHAVIOUR the spine used to infer from the step's id
    // (lib/spine.js, NAME_FALLBACK). They must be booleans: this parser makes every scalar a
    // string, so `lands: yes` would otherwise reach stepDeclares and throw at gate time — on a
    // live run, far from the pack that is wrong. Caught here, `plt validate` names the file.
    // `pane` says WHERE a step's work is visible: the brain's pane, the card's own pane, or
    // nowhere. It is not effort-only — a workflow step's default is `card` — and it is inert when
    // no window driver is configured, which is why an unknown value must be refused here rather
    // than discovered by a driver that silently addresses the wrong pane.
    if (s.pane !== undefined && s.pane !== null && !['brain', 'card', 'none'].includes(s.pane)) {
      errors.push({ line, msg: `step \`${s.id}\`: \`pane\` must be brain|card|none, not \`${s.pane}\`` });
    }
    for (const k of ['lands', 'checks_drift']) {
      if (s[k] === undefined || s[k] === null) continue;
      if (![true, false, 'true', 'false'].includes(s[k])) {
        errors.push({ line, msg: `step \`${s.id}\`: \`${k}\` must be true or false` });
      }
    }
    if (s.gate && typeof s.gate === 'object') for (const k of ['quorum', 'timeout', 'max_open_severity', 'by']) if (s.gate[k] !== undefined) dead(`gate.${k}`);
    if (s.jira && typeof s.jira === 'object' && s.jira.sprint !== undefined) dead('jira.sprint');
    for (const key of ['skills', 'agents', 'tools']) {
      if (s[key] === undefined) continue;
      if (typeof s[key] === 'string' && /^\{\{.*\}\}$/.test(s[key])) continue;   // resolved from config at launch
      if (!listOfNames(s[key])) { errors.push({ line, msg: `step \`${s.id}\`: \`${key}\` must be an inline list of names` }); continue; }
      const onDisk = key === 'skills' ? opts.skillsOnDisk : key === 'agents' ? opts.agentsOnDisk : null;
      // A `plugin:skill` name is installed by its plugin, not under a skills directory, so it is
      // never checked against disk.
      if (onDisk) for (const n of s[key]) if (!(key === 'skills' && n.includes(':')) && !onDisk.has(n)) errors.push({ line, msg: `step \`${s.id}\`: ${key.slice(0, -1)} \`${n}\` is not on disk` });
    }
    if (s.artifact !== undefined && (typeof s.artifact !== 'string' || (templates.size > 0 && !templates.has(s.artifact)))) {
      errors.push({ line, msg: `step \`${s.id}\`: artifact \`${s.artifact}\` is not a known template` });
    }
    // `files` — receipts the step's own command records directly (`plt receipt --kind file`),
    // for CLI work with no skill/tool/agent name of its own (see lib/spine.js#compileRequirements).
    if (s.files !== undefined && !listOfNames(s.files)) {
      errors.push({ line, msg: `step \`${s.id}\`: \`files\` must be an inline list of names` });
    }
    // `arm_on`/`land_on` name a live PR fact the poll produces. An unknown name is not a
    // no-op with a warning — it reads `undefined` on every poll, never equals anything, and the
    // step waits forever in silence. So the name is checked against the collector's own list
    // (`lib/spine.js#POLL_FACTS`), which is the only place the two can agree.
    for (const key of ['arm_on', 'land_on']) {
      const a = s[key];
      if (a === undefined) continue;
      if (typeof a !== 'object' || Array.isArray(a) || !a.gh) {
        errors.push({ line, msg: `step \`${s.id}\`: \`${key}\` must be a block map with \`gh\` and \`equals\`` });
        continue;
      }
      if (a.equals === undefined) errors.push({ line, msg: `step \`${s.id}\`: \`${key}\` needs \`equals\`` });
      if (key === 'land_on' && a.outcome !== undefined && !outcomesOf(s.id).includes(a.outcome)) {
        errors.push({ line, msg: `step \`${s.id}\`: land_on.outcome \`${a.outcome}\` is not one of the step's outcomes (${outcomesOf(s.id).join(', ')})` });
      }
      if (!POLL_FACTS.includes(a.gh)) {
        errors.push({ line, msg: `step \`${s.id}\`: ${key}.gh \`${a.gh}\` is not a fact the poll produces (${POLL_FACTS.join(', ')})` });
      }
    }
    if (s.gate !== undefined) {
      const g = s.gate;
      if (typeof g !== 'object' || Array.isArray(g)) errors.push({ line, msg: `step \`${s.id}\`: \`gate\` must be a block map` });
      else {
        if (!['adversarial', 'human', 'external'].includes(g.kind)) errors.push({ line, msg: `step \`${s.id}\`: gate.kind \`${g.kind}\` must be adversarial|human|external` });
        if (g.kind === 'human') {
          const signals = (cfg.gates && cfg.gates.human_signals) || null;
          if (!g.signal) errors.push({ line, msg: `step \`${s.id}\`: human gate needs \`signal\`` });
          else if (signals && !signals.includes(g.signal)) errors.push({ line, msg: `step \`${s.id}\`: gate.signal \`${g.signal}\` is not in config.gates.human_signals` });
        }
        if (g.kind === 'adversarial' && g.agents === undefined) errors.push({ line, msg: `step \`${s.id}\`: adversarial gate needs \`agents\`` });
        // `mode` says what a failing reviewer does: `hard` holds the step (a missing receipt);
        // `banner` records the fail and prime shows it as a warning. Required, so a formula
        // never blocks or waves through by accident. A ref must be `{{config.<key>}}` — a bare
        // `{{...}}` (a typo'd prefix like `{{cfg....}}`) is not a config reference and must not
        // pass. Whether the key RESOLVES is deliberately not checked: `compileRequirements` defaults
        // any unresolved mode ref in code (lib/spine.js#gateModeFallback — `banner` for a writing/prose
        // knob, `hard` for every other), so config is an override, never a requirement — and there is
        // no key list here to drift out of sync.
        if (g.kind === 'adversarial') {
          if (g.mode === undefined) {
            errors.push({ line, msg: `step \`${s.id}\`: adversarial gate needs \`mode: hard|banner\`` });
          } else if (!['hard', 'banner'].includes(g.mode)) {
            const m = String(g.mode).match(/^\{\{\s*config\.([\w.]+)\s*\}\}$/);
            if (!m) {
              errors.push({ line, msg: `step \`${s.id}\`: gate.mode \`${g.mode}\` must be hard|banner` });
            }
          }
        }
      }
    }
    if (s.jira !== undefined) {
      const statuses = (cfg.jira && cfg.jira.statuses) || null;
      for (const k of ['on_start', 'on_done']) {
        if (s.jira[k] !== undefined && !/^\{\{.*\}\}$/.test(String(s.jira[k])) && statuses && !statuses.includes(s.jira[k])) {
          errors.push({ line, msg: `step \`${s.id}\`: jira.${k} \`${s.jira[k]}\` is not in config.jira.statuses` });
        }
      }
    }
    // Parallel-lane keys: `overlap` names the effort whose in-flight runs the step is checked
    // against (`effort` = this run's own inputs.effort, or a literal effort slug); `touches` marks
    // the step that records the declared touches receipt.
    if (s.overlap !== undefined && (typeof s.overlap !== 'string' || (s.overlap !== 'effort' && !/^[a-z0-9][a-z0-9-]*$/.test(s.overlap)))) {
      errors.push({ line, msg: `step \`${s.id}\`: \`overlap\` must be \`effort\` or a slug ([a-z0-9-], no leading -), got \`${s.overlap}\`` });
    }
    if (s.touches !== undefined && s.touches !== 'declared') {
      errors.push({ line, msg: `step \`${s.id}\`: \`touches\` must be \`declared\`, got \`${s.touches}\`` });
    }
    // `effort: dropped` — the step is gated on the card being listed under `dropped:` in its effort file.
    if (s.effort !== undefined && s.effort !== 'dropped') {
      errors.push({ line, msg: `step \`${s.id}\`: \`effort\` must be \`dropped\`, got \`${s.effort}\`` });
    }
    // `verify.gh` names a receipt the facts collector records, so the allowlist is the collector's
    // own list (lib/facts.js#GH_FACT_NAMES), compared the way the collector matches names (`-` and
    // `_` as one character, spine.normalizeGhName). `pr-facts` is the one extra: `recordFacts`
    // records it on its own path, outside `candidateNames`, and review-pr's intake step verifies it.
    if (s.verify !== undefined && s.verify.gh !== undefined) {
      const known = new Set([...GH_FACT_NAMES, 'pr-facts'].map(normalizeGhName));
      const gh = Array.isArray(s.verify.gh) ? s.verify.gh : [s.verify.gh];
      for (const v of gh) if (!known.has(normalizeGhName(v))) errors.push({ line, msg: `step \`${s.id}\`: verify.gh \`${v}\` is unknown` });
    }

    // The four prose keys. Each is filled by a DIFFERENT substitution — or by none — so a `{x}`
    // that is fine in one is printed literally in another. The validator has to know which:
    //   title, notes — `interpolate(…, inputs)` when the step spawns a task (bin/plt#buildTask)
    //   banner       — `renderBanners` fills exactly four run vars (lib/spine.js)
    //   waiting      — never substituted; `render` prints `d.waiting` raw (lib/render.js)
    for (const field of ['title', 'notes', 'banner', 'waiting']) {
      if (s[field] === undefined) continue;
      if (typeof s[field] !== 'string' || !s[field].trim()) {
        errors.push({ line, msg: `step \`${s.id}\`: \`${field}\` must be a non-empty string` });
        continue;
      }
      for (const ph of placeholders(s[field])) {
        if (field === 'banner') {
          if (!BANNER_VARS.includes(ph)) errors.push({ line, msg: `step \`${s.id}\`: banner uses {${ph}}; renderBanners fills only ${BANNER_VARS.map((v) => `{${v}}`).join(' ')} — anything else prints literally` });
        } else if (field === 'waiting') {
          errors.push({ line, msg: `step \`${s.id}\`: waiting uses {${ph}}, but \`waiting\` is never substituted — it prints literally` });
        } else if (!inputs.has(ph)) {
          errors.push({ line, msg: `step \`${s.id}\`: ${field} uses {${ph}} which is not a declared input` });
        }
      }
    }

    // `manual: true` means "a person starts this step, not the agent". The formula parser keeps
    // every scalar as a STRING, and `nextCommand` reads it as `Boolean(def.manual)` — so the
    // string `"false"` was truthy and `manual: false` did the opposite of what it says. Only the
    // two words are accepted here; lib/spine.js#isManual now reads `false` as false.
    if (s.manual !== undefined && !['true', 'false', true, false].includes(s.manual)) {
      errors.push({ line, msg: `step \`${s.id}\`: \`manual: ${s.manual}\` must be true or false` });
    }

    // Each name in `tools`/`files` compiles to a requirement satisfied only by a receipt with the
    // SAME name, so a name with a space or a duplicate is a requirement that can never be met, or
    // one that is met twice over. The shape check above already ran; this checks the names.
    for (const key of ['tools', 'files']) {
      if (!Array.isArray(s[key])) continue;
      for (const n of s[key]) {
        if (!/^[A-Za-z0-9][\w.:/-]*$/.test(String(n))) {
          errors.push({ line, msg: `step \`${s.id}\`: ${key.slice(0, -1)} name \`${n}\` must be a plain name (letters, digits, \`. _ - : /\`)` });
        }
      }
      if (new Set(s[key]).size !== s[key].length) errors.push({ line, msg: `step \`${s.id}\`: \`${key}\` has duplicates` });
    }

    // `reapprove: { artifact, rearm }` — a second approval of a done human gate needs that
    // artifact republished at the new pin, then re-readies the named steps. A wrong artifact name
    // only shows up at the re-approval, as a refusal nobody can act on; a `rearm` id that matches
    // no step is skipped in silence (lib/spine.js#gateApprove).
    if (s.reapprove !== undefined) {
      const r = s.reapprove;
      if (typeof r !== 'object' || Array.isArray(r)) {
        errors.push({ line, msg: `step \`${s.id}\`: \`reapprove\` must be a block map with \`artifact\` and/or \`rearm\`` });
      } else {
        for (const k of Object.keys(r)) {
          if (!['artifact', 'rearm', '__line', '__indent'].includes(k)) errors.push({ line, msg: `step \`${s.id}\`: reapprove.${k} is read by nothing; only \`artifact\` and \`rearm\` are` });
        }
        if (r.artifact !== undefined && (typeof r.artifact !== 'string' || (templates.size > 0 && !templates.has(r.artifact)))) {
          errors.push({ line, msg: `step \`${s.id}\`: reapprove.artifact \`${r.artifact}\` is not a known template` });
        }
        if (r.rearm !== undefined) {
          if (!Array.isArray(r.rearm)) errors.push({ line, msg: `step \`${s.id}\`: \`reapprove.rearm\` must be an inline list of step ids` });
          else for (const id of r.rearm) {
            if (!byId.has(id)) errors.push({ line, msg: `step \`${s.id}\`: reapprove.rearm \`${id}\` is not a step in this file` });
            else if (id === s.id) errors.push({ line, msg: `step \`${s.id}\`: reapprove.rearm names its own step` });
          }
        }
      }
    }
    // `rearm` only exists inside `reapprove`. At the top of a step it is read by nothing.
    if (s.rearm !== undefined) errors.push({ line, msg: `step \`${s.id}\`: \`rearm\` belongs under \`reapprove\`; on its own it is read by nothing` });
  }

  const cycle = findDependencyCycle(steps.filter((s) => s.id));
  if (cycle) {
    errors.push({ line: parsed.stepsLine || 1, msg: `dependency cycle: ${cycle.join(' -> ')} (loops are only allowed via repeat_until/on_fail)` });
  }

  return errors;
}

// ------------------------------------------------------------------ opts

// How deep the skill walk goes below a `skills` root: `<root>/a/SKILL.md` is depth 1, and a
// grouped layout (`<root>/group/a/SKILL.md`) is depth 2.
const SKILL_DEPTH = 3;

// Directory entries with symlinks followed, or [] when the directory cannot be read.
function entriesOf(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    try { out.push({ name, full: path.join(dir, name), st: fs.statSync(path.join(dir, name)) }); } catch (e) { /* dangling link */ }
  }
  return out;
}

// A skill is a directory that holds a SKILL.md, named by that directory, at any depth up to
// SKILL_DEPTH. A directory without one is a container, not a skill, and the walk goes into it.
// It does not go into a skill. Each real path is visited once, so a symlink loop ends.
function skillNames(root) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { return; }
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of entriesOf(dir)) {
      if (!e.st.isDirectory()) continue;
      if (fs.existsSync(path.join(e.full, 'SKILL.md'))) out.push(e.name);
      else if (depth < SKILL_DEPTH) walk(e.full, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

// An agent is a `<name>.md` file in an `agents` root, or one directory below it.
function agentNames(root) {
  const out = [];
  for (const e of entriesOf(root)) {
    if (e.st.isFile() && e.name.endsWith('.md')) out.push(e.name.slice(0, -3));
    else if (e.st.isDirectory()) {
      for (const f of entriesOf(e.full)) if (f.st.isFile() && f.name.endsWith('.md')) out.push(f.name.slice(0, -3));
    }
  }
  return out;
}

// Claude Code reads skills and agents from the project's `.claude/` and the user's
// `~/.claude/`, so a name is on disk when either holds it. The project is the directory that
// holds `process/` (lib/spine.js#findProcessDir).
function onDiskDirs(processDir, home) {
  const roots = [];
  if (processDir) roots.push(path.join(path.dirname(path.resolve(processDir)), '.claude'));
  roots.push(path.join(home, '.claude'));
  return roots;
}

// buildOpts(processDir) -> {config, skillsOnDisk: Set, agentsOnDisk: Set}
// The config loads through lib/spine.js#loadConfig, the same merge every other verb reads.
// `processDir` may be null (no process/ above the caller) or hold no config/: the config is then
// `{}`, so the config checks have no list to check against. With no processDir, only the
// user-level directories are scanned.
function buildOpts(processDir, { home = os.homedir() } = {}) {
  const hasConfig = processDir && fs.existsSync(path.join(processDir, 'config'));
  const config = hasConfig ? require('./spine').loadConfig(processDir) : {};
  const dirs = onDiskDirs(processDir, home);
  return {
    config,
    skillsOnDisk: new Set(dirs.flatMap((d) => skillNames(path.join(d, 'skills')))),
    agentsOnDisk: new Set(dirs.flatMap((d) => agentNames(path.join(d, 'agents')))),
  };
}

// The process directory a caller means: `--project <dir>` first (as `plt fsck` reads it), then
// $PLT_PROCESS_DIR, then the nearest `process/config` above `cwd`. Null when there is none.
function resolveProcessDir({ project, env = process.env, cwd = process.cwd() } = {}) {
  if (typeof project === 'string') {
    const dir = path.resolve(cwd, project);
    if (fs.existsSync(path.join(dir, 'process', 'config'))) return path.join(dir, 'process');
    if (fs.existsSync(path.join(dir, 'config'))) return dir;
    throw new Error(`no process/config directory under ${dir}`);
  }
  return env.PLT_PROCESS_DIR || require('./spine').findProcessDir(cwd) || null;
}

// validateFile(file, {processDir, templates}) -> {ok, errors: [{line, msg}]}
// Read, parse and validate one workflow file, with the opts built from `processDir`.
// `templates` defaults to the template names plt can resolve.
function validateFile(file, { processDir = null, templates, home } = {}) {
  const plt = require('../bin/plt');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, errors: [{ line: 1, msg: `cannot read file: ${e.message}` }] };
  }
  const opts = buildOpts(processDir, { home });
  const errors = validateWorkflow(plt.parseWorkflow(text), file, templates || plt.templateNames(), opts);
  return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------ plt validate

function cmdValidate(args, ctx = {}) {
  const plt = require('../bin/plt');
  const cwd = ctx.cwd || process.cwd();
  const env = ctx.env || process.env;
  const rest = [];
  let project;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') {
      project = args[++i];
      if (!project) { process.stderr.write('plt validate: --project needs a directory\n'); return 2; }
    } else rest.push(args[i]);
  }
  let processDir;
  try { processDir = resolveProcessDir({ project, env, cwd }); } catch (e) {
    process.stderr.write(`plt validate: ${e.message}\n`);
    return 1;
  }
  if (!processDir) {
    process.stderr.write('plt validate: no process/config found; the config checks have nothing to check against (pass --project <dir>)\n');
  }
  const opts = buildOpts(processDir);

  const target = rest[0] || 'all';
  let files;
  if (target === 'all') {
    files = plt.collectFiles();
    if (files.length === 0) {
      process.stderr.write('plt validate: no template files found under templates/ or workflows/\n');
      return 1;
    }
  } else {
    const p = path.resolve(cwd, target);
    if (!fs.existsSync(p)) {
      process.stderr.write(`plt validate: no such file: ${target}\n`);
      return 1;
    }
    files = fs.statSync(p).isDirectory() ? plt.walk(p, []) : [p];
  }

  // The process dir's own templates count, as they do at launch (lib/spine.js#formulaTemplates).
  const templates = processDir ? require('./spine').formulaTemplates(processDir) : plt.templateNames();
  let failed = 0;
  for (const file of files) {
    const result = plt.validateFile(file, templates, opts);
    const shown = file.startsWith(plt.ROOT + path.sep) ? path.relative(plt.ROOT, file) : file;
    if (result.length === 0) {
      process.stdout.write(`OK    ${shown}\n`);
    } else {
      failed++;
      for (const e of result) process.stdout.write(`FAIL  ${shown}:${e.line}: ${e.msg}\n`);
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed} of ${files.length} file(s) failed validation\n`);
    return 1;
  }
  // keep the generated index.json fresh: any templates change is meant to pass
  // `validate all` first, so regenerate here on a clean full run (post-write).
  if (target === 'all' && plt.writeIndex()) {
    process.stdout.write(`(regenerated ${path.relative(plt.ROOT, plt.indexPath())})\n`);
  }
  return 0;
}

const commands = [
  { name: 'validate', usage: 'plt validate [path|all] [--project <dir>]', handler: (argv, ctx) => cmdValidate(argv, ctx) },
];

module.exports = {
  BANNER_VARS,
  placeholders,
  findDependencyCycle,
  validateWorkflow,
  buildOpts,
  resolveProcessDir,
  validateFile,
  commands,
};
