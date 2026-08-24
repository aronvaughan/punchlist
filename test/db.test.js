import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open, ulid, MigrationError } from '../src/db.js';

test('migrate applies 001-init once, records version, enables pragmas', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  migrate(); // idempotent
  const versions = db.prepare('SELECT version FROM schema_migrations').all();
  assert.deepEqual(versions.map(v => v.version), ['001-init']);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  // schema present
  db.prepare('SELECT id FROM tasks').all();
  db.prepare('SELECT id FROM projects').all();
});

test('schema CHECKs: status enum, when pairing, recur requires due', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const ins = db.prepare(`INSERT INTO tasks (id,title,status,when_type,when_date,due_date,recur,created_at,updated_at)
                          VALUES (?,?,?,?,?,?,?,'t','t')`);
  assert.throws(() => ins.run('1', 'x', 'inbox', null, null, null, null)); // bad status
  assert.throws(() => ins.run('2', 'x', 'active', 'date', null, null, null)); // date w/o when_date
  assert.throws(() => ins.run('3', 'x', 'active', null, '2026-01-01', null, null)); // when_date w/o type
  assert.throws(() => ins.run('4', 'x', 'active', null, null, null, '{"freq":"daily"}')); // recur w/o due
  ins.run('5', 'x', 'active', 'date', '2026-01-01', '2026-01-02', '{"freq":"daily"}'); // ok
});

test('FK: task project must exist; steps cascade on task delete', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  assert.throws(() => db.prepare(
    `INSERT INTO tasks (id,title,status,project_id,created_at,updated_at) VALUES ('t1','x','active','nope','t','t')`).run());
  db.exec(`INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('t1','x','active','t','t')`);
  db.exec(`INSERT INTO steps (id,task_id,title) VALUES ('s1','t1','step')`);
  db.exec(`DELETE FROM tasks WHERE id='t1'`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM steps').get().c, 0);
});

test('file-backed migrate pre-copies db file; failed migration is named + rolled back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const dbPath = join(dir, 'av-tasks.db');
  const { db, migrate } = open(dbPath);
  migrate();
  assert.ok(existsSync(`${dbPath}.pre-001`));

  // a broken second migration must fail with MigrationError and leave no trace
  const migDir = join(dir, 'migs');
  mkdirSync(migDir);
  writeFileSync(join(migDir, '002-broken.sql'), 'CREATE TABLE ok(x); INSERT INTO nope VALUES (1);');
  assert.throws(() => migrate(migDir), MigrationError);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM schema_migrations WHERE version='002-broken'`).get().c, 0);
  assert.throws(() => db.prepare('SELECT * FROM ok').all()); // rolled back
  rmSync(dir, { recursive: true, force: true });
});

test('pre-copy is WAL-safe: opening the pre-NNN snapshot sees committed data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const dbPath = join(dir, 'av-tasks.db');
  const { db, migrate } = open(dbPath);
  migrate(); // applies 001 — schema commits land in the -wal file, not the main db
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Home', 't', 't')`).run();

  const migDir = join(dir, 'migs');
  mkdirSync(migDir);
  writeFileSync(join(migDir, '002-noop.sql'), 'CREATE TABLE extra(x);');
  migrate(migDir);
  assert.ok(existsSync(`${dbPath}.pre-002`));

  // the safety net must be restorable: tables AND committed rows present
  const { db: snap } = open(`${dbPath}.pre-002`);
  const tables = snap.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert.ok(tables.includes('projects'), `pre-copy has no tables: ${JSON.stringify(tables)}`);
  assert.equal(snap.prepare('SELECT COUNT(*) c FROM projects').get().c, 1, 'pre-copy lost committed rows');
  assert.ok(!tables.includes('extra'), 'pre-copy must predate the migration it guards');
  rmSync(dir, { recursive: true, force: true });
});

test('pre-copy overwrites a stale snapshot from an earlier failed attempt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const dbPath = join(dir, 'av-tasks.db');
  const { migrate } = open(dbPath);
  migrate();
  const migDir = join(dir, 'migs');
  mkdirSync(migDir);
  writeFileSync(join(migDir, '002-broken.sql'), 'INSERT INTO nope VALUES (1);');
  assert.throws(() => migrate(migDir), MigrationError); // leaves a pre-002 behind
  writeFileSync(join(migDir, '002-broken.sql'), 'CREATE TABLE fixed(x);');
  migrate(migDir); // retry must not trip over the existing pre-002
  const { db: snap } = open(`${dbPath}.pre-002`);
  snap.prepare('SELECT COUNT(*) c FROM projects').get();
  rmSync(dir, { recursive: true, force: true });
});

test('a migration that breaks FK integrity is rolled back (foreign_key_check gate); FKs re-enabled after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const { db, migrate } = open(join(dir, 'av-tasks.db'));
  migrate();
  const migDir = join(dir, 'migs');
  mkdirSync(migDir);
  // runs FK-off, so this INSERT succeeds — the foreign_key_check gate must catch it
  writeFileSync(join(migDir, '002-orphan.sql'),
    `INSERT INTO steps (id, task_id, title) VALUES ('s1', 'ghost-task', 'orphan');`);
  assert.throws(() => migrate(migDir), /foreign_key_check/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM steps').get().c, 0, 'rolled back');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'FKs re-enabled');
  rmSync(dir, { recursive: true, force: true });
});

test('ulid: 26 chars, lexicographically time-ordered', () => {
  const a = ulid(1000), b = ulid(2000);
  assert.equal(a.length, 26);
  assert.ok(a < b);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});
