import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open, ulid, MigrationError } from '../src/db.js';

test('migrate applies each migration once, records versions, enables pragmas', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  migrate(); // idempotent
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(versions.map(v => v.version), ['001-init', '002-delegation', '003-vetting']);
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
  const dbPath = join(dir, 'punchlist.db');
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
  const dbPath = join(dir, 'punchlist.db');
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
  const dbPath = join(dir, 'punchlist.db');
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

test('002-delegation upgrades a lived-in 001 db: data, FKs, indexes and old constraints survive; new columns land', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const dbPath = join(dir, 'punchlist.db');
  // seed a database that only knows 001 (copy just that migration aside)
  const migDir001 = join(dir, 'migs-001');
  mkdirSync(migDir001);
  writeFileSync(join(migDir001, '001-init.sql'),
    readFileSync(join(import.meta.dirname, '..', 'migrations', '001-init.sql')));
  const { db, migrate } = open(dbPath);
  migrate(migDir001);
  const now = '2026-08-01T00:00:00.000Z';
  db.prepare(`INSERT INTO projects (id,name,rank,created_at,updated_at) VALUES ('p1','Home',1,?,?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id,title,project_id,status,due_date,recur,created_by,created_at,updated_at)
              VALUES ('t1','recurring','p1','active','2026-08-05','{"freq":"daily","anchor":"due"}','alex',?,?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id,title,status,spawned_from,created_at,updated_at)
              VALUES ('t2','spawned','done','t1',?,?)`).run(now, now);
  db.prepare(`INSERT INTO steps (id,task_id,title) VALUES ('s1','t1','step one')`).run();
  db.prepare(`INSERT INTO tags (id,name) VALUES ('g1','chore')`).run();
  db.prepare(`INSERT INTO task_tags (task_id,tag_id) VALUES ('t1','g1')`).run();

  migrate(); // real migrations dir — applies 002 (rebuild) and 003 (vetting)
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version),
    ['001-init', '002-delegation', '003-vetting']);
  // data survived; existing rows got assignee='alex' and the new defaults
  const t1 = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1');
  assert.equal(t1.title, 'recurring');
  assert.equal(t1.assignee, 'owner');
  assert.equal(t1.auto_close, 0);
  assert.equal(t1.claimed_at, null);
  assert.equal(t1.report, null);
  assert.equal(t1.recur, '{"freq":"daily","anchor":"due"}');
  assert.equal(db.prepare('SELECT spawned_from FROM tasks WHERE id = ?').get('t2').spawned_from, 't1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_tags').get().c, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // extended status CHECK: new states accepted, junk still rejected
  const ins = db.prepare(`INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES (?,?,?,'t','t')`);
  ins.run('t3', 'x', 'review');
  ins.run('t4', 'x', 'in_progress');
  assert.throws(() => ins.run('t5', 'x', 'inbox'));
  // old constraints survive the rebuild
  assert.throws(() => db.prepare(
    `INSERT INTO tasks (id,title,status,when_type,created_at,updated_at) VALUES ('t6','x','active','date','t','t')`).run());
  assert.throws(() => db.prepare(
    `INSERT INTO tasks (id,title,status,recur,created_at,updated_at) VALUES ('t7','x','active','{"freq":"daily"}','t','t')`).run());
  assert.throws(() => db.prepare(
    `INSERT INTO tasks (id,title,status,project_id,created_at,updated_at) VALUES ('t8','x','active','ghost','t','t')`).run());
  // steps still cascade on task delete
  db.prepare(`DELETE FROM task_tags WHERE task_id='t1'`).run();
  db.prepare(`UPDATE tasks SET spawned_from=NULL WHERE id='t2'`).run();
  db.prepare(`DELETE FROM tasks WHERE id='t1'`).run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM steps').get().c, 0);
  // every existing index recreated (+ the new assignee one)
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'`).all().map(r => r.name);
  for (const want of ['idx_tasks_project', 'idx_tasks_status_when', 'idx_tasks_due', 'idx_tasks_assignee']) {
    assert.ok(idx.includes(want), `missing index ${want}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('003-vetting backfill: existing rows vetted=1 EXCEPT created_by=email -> 0 (regardless of assignee)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const dbPath = join(dir, 'punchlist.db');
  // seed a database that only knows 001+002
  const migDirPre = join(dir, 'migs-pre');
  mkdirSync(migDirPre);
  for (const f of ['001-init.sql', '002-delegation.sql']) {
    writeFileSync(join(migDirPre, f), readFileSync(join(import.meta.dirname, '..', 'migrations', f)));
  }
  const { db, migrate } = open(dbPath);
  migrate(migDirPre);
  const ins = db.prepare(`INSERT INTO tasks (id,title,status,created_by,assignee,created_at,updated_at)
                          VALUES (?,?,'active',?,?,'t','t')`);
  ins.run('t1', 'owner task', 'alex', 'alex');
  ins.run('t2', 'agent-made', 'claude', 'hermes');
  ins.run('t3', 'from email for agent', 'email', 'hermes');
  // the noted live-db case: email-created but assigned to the human —
  // backfill keys on PROVENANCE, so this becomes unvetted too (acceptable:
  // complete/PATCH stay open, and the admin can vet it)
  ins.run('t4', 'from email for alex', 'email', 'alex');
  migrate(); // real dir — applies 003 only
  const vetted = id => db.prepare('SELECT vetted FROM tasks WHERE id = ?').get(id).vetted;
  assert.equal(vetted('t1'), 1);
  assert.equal(vetted('t2'), 1);
  assert.equal(vetted('t3'), 0);
  assert.equal(vetted('t4'), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a migration that breaks FK integrity is rolled back (foreign_key_check gate); FKs re-enabled after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtasks-'));
  const { db, migrate } = open(join(dir, 'punchlist.db'));
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
