// server.js — entry point. Fail-closed startup: refuses to run without
// well-formed per-actor tokens. Minimal node:http -> fetch adapter so Hono
// stays the only runtime dependency.
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { open } from './db.js';
import { buildApp } from './api.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.PUNCHLIST_DATA || join(ROOT, 'data');
const PORT = Number(process.env.PUNCHLIST_PORT || 8600);
const HOST = process.env.PUNCHLIST_HOST || '127.0.0.1';

// data/.env holds the bearer tokens — it must be chmod 600 (M3 installs
// scripts own enforcement; until then, warn loudly on permissive modes).
export function envPermWarning(mode, path = 'data/.env') {
  if ((mode & 0o077) === 0) return null;
  return `punchlist: WARNING: ${path} is readable by group/other ` +
    `(mode ${(mode & 0o777).toString(8).padStart(3, '0')}) — it contains auth tokens; run: chmod 600 ${path}`;
}

function loadEnvFile() {
  const envPath = join(DATA_DIR, '.env');
  if (!existsSync(envPath)) return;
  if (process.platform !== 'win32') {
    const warn = envPermWarning(statSync(envPath).mode, envPath);
    if (warn) console.error(warn);
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

// PUNCHLIST_TOKENS = name:token,name:token — fail closed (review O9)
export function parseTokens(raw) {
  const tokens = {};
  for (const pair of (raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    const name = i > 0 ? pair.slice(0, i).trim() : '';
    const token = i > 0 ? pair.slice(i + 1).trim() : '';
    if (!name || !token) throw new Error(`malformed token pair: "${pair}" (want name:token)`);
    if (token.length < 32) throw new Error(`token for "${name}" is shorter than 32 chars — refusing to start`);
    if (tokens[name]) throw new Error(`duplicate actor name: ${name}`);
    tokens[name] = token;
  }
  if (Object.keys(tokens).length === 0) {
    throw new Error('PUNCHLIST_TOKENS is not set — refusing to start without auth (fail closed)');
  }
  return tokens;
}

// PUNCHLIST_ADMIN names the admin (human) actor — approves reviews, owns the
// Today/Inbox lanes. Defaults to the FIRST actor in PUNCHLIST_TOKENS; if set
// explicitly it must name an actor that has a token (fail closed).
export function resolveAdmin(tokens, raw) {
  const admin = (raw || '').trim() || Object.keys(tokens)[0];
  if (!tokens[admin]) {
    throw new Error(`PUNCHLIST_ADMIN="${admin}" has no token in PUNCHLIST_TOKENS — refusing to start`);
  }
  return admin;
}

// PUNCHLIST_UNTRUSTED_ACTORS = comma list of actors whose task creations are
// born vetted=0 (agent-security layer 1). Unset -> default "email"; set but
// empty -> nobody is untrusted (explicit opt-out).
export function parseUntrusted(raw) {
  return (raw ?? 'email').split(',').map(s => s.trim()).filter(Boolean);
}

// One-time migration from the pre-rename database filename: if the data dir
// still has av-tasks.db and no punchlist.db yet, rename it (plus any WAL/SHM
// sidecars — SQLite locates them by the main db's filename). Returns true if
// a rename happened.
export function migrateLegacyDb(dataDir, log = console.error) {
  const legacy = join(dataDir, 'av-tasks.db');
  const current = join(dataDir, 'punchlist.db');
  if (!existsSync(legacy) || existsSync(current)) return false;
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(legacy + ext)) renameSync(legacy + ext, current + ext);
  }
  log(`punchlist: migrated legacy database ${legacy} -> ${current}`);
  return true;
}

function toRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const init = { method: req.method, headers: req.headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export function serve(app, { host, port }) {
  const server = createServer(async (req, res) => {
    try {
      const r = await app.fetch(toRequest(req));
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnvFile();
  let tokens, admin;
  try {
    tokens = parseTokens(process.env.PUNCHLIST_TOKENS);
    admin = resolveAdmin(tokens, process.env.PUNCHLIST_ADMIN);
  } catch (err) {
    console.error(`punchlist: FATAL: ${err.message}`);
    process.exit(1);
  }
  mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyDb(DATA_DIR);
  const { db, migrate } = open(join(DATA_DIR, 'punchlist.db'));
  try {
    migrate();
  } catch (err) {
    console.error(`punchlist: FATAL: ${err.name}: ${err.message}`);
    process.exit(1);
  }
  const app = buildApp({ db, tokens, admin,
    untrusted: parseUntrusted(process.env.PUNCHLIST_UNTRUSTED_ACTORS) });
  const server = serve(app, { host: HOST, port: PORT });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`punchlist: FATAL: EADDRINUSE — port ${PORT} on ${HOST} is already taken ` +
        `(another punchlist instance?). Stop it or set PUNCHLIST_PORT.`);
    } else {
      console.error(`punchlist: FATAL: ${err.message}`);
    }
    process.exit(1);
  });
  server.on('listening', () => {
    console.log(`punchlist listening on http://${HOST}:${PORT} (actors: ${Object.keys(tokens).join(', ')}; admin: ${admin})`);
  });
}
