'use strict';
// schemas — the shape of every file the spine writes, stated once, in JSON Schema (draft 2020-12).
//
// One entry point carries every caller: `validateObject(kind, obj)`. `doctor`, `fsck` and the
// `plt schema` command all go through it, and none of them ever sees ajv. That is the point — the
// validation engine is an implementation detail of this file, so replacing it is a one-file change.
//
// The schemas themselves live as data in `<repo>/schemas/*.schema.json`, not as JavaScript object
// literals, so an editor, a CI step or a person can read and check them without running plt.
const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');
const KINDS = ['state', 'event', 'inputs', 'effort', 'config'];

// Event ledgers are append-only and never rewritten. The writers were brought in line with the
// event schema at one commit (fa0beaa, "reconcile the five schemas with what the code writes");
// an event written before it that fails the schema is legacy — a warning (W_EVENT_LEGACY), not an
// error. An event written after it is held to the schema strictly. An event with no readable `ts`
// cannot prove its age, so it is held strictly too.
const EVENT_WRITER_FIX_TS = '2026-09-24T18:05:36Z';
function isLegacyEvent(ev) {
  const t = Date.parse(ev && ev.ts);
  return Number.isFinite(t) && t < Date.parse(EVENT_WRITER_FIX_TS);
}

function schemaPath(kind) {
  return path.join(SCHEMA_DIR, `${kind}.schema.json`);
}

let cachedSchemas = null;

// The five parsed schemas, read once. Keyed by kind, not by file name, because the kind is what
// every caller names.
function loadSchemas() {
  if (cachedSchemas) return cachedSchemas;
  const out = {};
  for (const kind of KINDS) out[kind] = JSON.parse(fs.readFileSync(schemaPath(kind), 'utf8'));
  cachedSchemas = out;
  return out;
}

let cachedValidators = null;

// An RFC 3339 timestamp, which is what every `ts` in the ledger is. Declared here rather than by
// pulling in ajv-formats: one format is not worth a second dependency, and an undeclared format is
// silently ignored by ajv — the schema would say `date-time` and check nothing.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// `allErrors` because a caller wants the whole list of what is wrong with a file in one pass, not
// the first problem. `strict` is off because the schemas carry `format` and descriptive keywords
// that ajv would otherwise refuse to compile.
function validators() {
  if (cachedValidators) return cachedValidators;
  const Ajv2020 = require('ajv/dist/2020');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', DATE_TIME);
  const schemas = loadSchemas();
  const out = {};
  for (const kind of KINDS) out[kind] = ajv.compile(schemas[kind]);
  cachedValidators = out;
  return out;
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown schema kind: ${kind} (want one of: ${KINDS.join(', ')})`);
}

// validateObject(kind, obj) -> {ok, errors}. `errors` is [] when ok; otherwise one entry per
// problem, `path` being where in the object it sits ('' = the object itself).
function validateObject(kind, obj) {
  assertKind(kind);
  const validate = validators()[kind];
  const ok = validate(obj) === true;
  if (ok) return { ok: true, errors: [] };
  return { ok: false, errors: (validate.errors || []).map(toError) };
}

// ajv reports an unexpected key against the PARENT object, so five stray keys all read
// `/: must NOT have additional properties` and name none of them. Point the path at the key itself:
// every error line then names one place in the file a person can go and fix.
function toError(e) {
  const extra = e.params && e.params.additionalProperty;
  const base = e.instancePath || '';
  return { path: extra ? `${base}/${extra}` : base, message: e.message || 'is invalid' };
}

// validateFile(kind, filePath) -> {ok, errors}. A `.jsonl` file is a ledger: every line is one
// object, validated on its own, and each error's path carries the line it came from so a person can
// open the file at that line.
function validateFile(kind, filePath) {
  assertKind(kind);
  const text = fs.readFileSync(filePath, 'utf8');
  if (!filePath.endsWith('.jsonl')) return validateObject(kind, yaml.parse(text));

  const errors = [];
  const warnings = [];   // legacy events (see isLegacyEvent) that fail the schema
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      errors.push({ path: `line ${i + 1}`, message: `not JSON: ${e.message}` });
      continue;
    }
    const into = kind === 'event' && isLegacyEvent(obj) ? warnings : errors;
    for (const err of validateObject(kind, obj).errors) {
      into.push({ path: `line ${i + 1}${err.path ? ' ' + err.path : ''}`, message: err.message });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

const USAGE = 'plt schema list | plt schema validate <kind> <file>';

// io is injected so a test reads the output instead of the terminal.
function schemaHandler(args, io = {}) {
  const write = io.write || ((t) => process.stdout.write(t));
  const error = io.error || ((t) => process.stderr.write(t));
  const [sub, kind, file] = args || [];

  if (sub === 'list') {
    for (const k of KINDS) write(`${k.padEnd(7)} ${schemaPath(k)}\n`);
    return 0;
  }

  if (sub !== 'validate' || !kind || !file) {
    error(`usage: ${USAGE}\n`);
    return 2;
  }
  if (!KINDS.includes(kind)) {
    error(`plt schema validate: unknown kind "${kind}" (want one of: ${KINDS.join(', ')})\nusage: ${USAGE}\n`);
    return 2;
  }
  const target = path.resolve(file);
  if (!fs.existsSync(target)) {
    error(`plt schema validate: no such file: ${target}\nusage: ${USAGE}\n`);
    return 2;
  }

  const result = validateFile(kind, target);
  if (result.ok) {
    const legacy = (result.warnings || []).length;
    write(`OK    ${target} (${kind})${legacy ? ` — ${legacy} W_EVENT_LEGACY warning(s): events written before the writer fix fail the schema, and the ledger is append-only` : ''}\n`);
    return 0;
  }
  for (const e of result.errors) error(`${e.path || '/'}: ${e.message}\n`);
  error(`${result.errors.length} problem(s) in ${target} — fix the file, then: plt schema validate ${kind} ${target}\n`);
  return 1;
}

const commands = [{ name: 'schema', usage: USAGE, handler: schemaHandler }];

module.exports = { KINDS, SCHEMA_DIR, EVENT_WRITER_FIX_TS, isLegacyEvent, schemaPath, loadSchemas, validators, validateObject, validateFile, schemaHandler, commands, USAGE };
