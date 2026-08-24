// db.js — open(path) -> {db, migrate()}. node:sqlite, WAL, FKs on,
// busy_timeout 5000. Migrations: each NNN-*.sql runs in ONE transaction
// together with its schema_migrations insert; file-backed dbs are copied
// aside (av-tasks.db.pre-NNN) before applying; failure -> named error.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export class MigrationError extends Error {
  constructor(version, cause) {
    super(`migration ${version} failed: ${cause.message}`);
    this.name = 'MigrationError';
    this.version = version;
    this.cause = cause;
  }
}

// ULID: 26-char Crockford base32, time-ordered, lexicographically sortable.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  let rand = '';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
  return time + rand;
}

export function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  function migrate(dir = MIGRATIONS_DIR) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)');
    const applied = new Set(
      db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
    const files = readdirSync(dir).filter(f => /^\d{3}-.*\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const nnn = file.slice(0, 3);
      if (path !== ':memory:' && existsSync(path)) {
        // pre-copy safety net — WAL-safe: a raw file copy would miss every
        // transaction still sitting in the -wal sidecar, so snapshot through
        // SQLite itself (same mechanism as scripts/db-snapshot.sh).
        const dest = `${path}.pre-${nnn}`;
        rmSync(dest, { force: true }); // VACUUM INTO refuses to overwrite
        db.prepare('VACUUM INTO ?').run(dest);
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      db.exec('BEGIN');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw new MigrationError(version, err);
      }
    }
  }

  return { db, migrate };
}
