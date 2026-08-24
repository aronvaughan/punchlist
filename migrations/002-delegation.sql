-- 002-delegation: assignee model (delegation design 2026-08-24).
-- tasks gains assignee/auto_close/claimed_at/report and the status CHECK
-- extends to in_progress/review. SQLite can't ALTER a CHECK, so this is a
-- table rebuild: new table, copy rows (existing rows assignee='aron'),
-- DROP + RENAME swap. The runner wraps this in one transaction with FKs
-- suspended and verifies PRAGMA foreign_key_check before COMMIT, so
-- steps/task_tags references survive intact (they re-bind to the renamed
-- table by name).

CREATE TABLE tasks_new (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  project_id   TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL CHECK (status IN ('active','in_progress','review','done','archived')),
  when_type    TEXT NULL CHECK (when_type IN ('date','someday')),
  when_date    TEXT NULL,
  due_date     TEXT NULL,
  due_time     TEXT NULL,
  rank         REAL,
  today_rank   REAL NULL,
  recur        TEXT NULL,
  spawned_from TEXT NULL REFERENCES tasks(id),
  created_by   TEXT,
  completed_at TEXT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  assignee     TEXT NOT NULL DEFAULT 'aron',  -- actor names (aron|claude|hermes|email…)
  auto_close   INTEGER NOT NULL DEFAULT 0,    -- finish goes straight to done
  claimed_at   TEXT NULL,                     -- set on claim
  report       TEXT NULL,                     -- agent's outcome note (markdown, notes caps)
  CHECK ((when_type IS 'date') = (when_date IS NOT NULL)),
  CHECK (recur IS NULL OR due_date IS NOT NULL)
);

INSERT INTO tasks_new (id, title, notes, project_id, status, when_type, when_date,
                       due_date, due_time, rank, today_rank, recur, spawned_from,
                       created_by, completed_at, created_at, updated_at,
                       assignee, auto_close, claimed_at, report)
  SELECT id, title, notes, project_id, status, when_type, when_date,
         due_date, due_time, rank, today_rank, recur, spawned_from,
         created_by, completed_at, created_at, updated_at,
         'aron', 0, NULL, NULL
  FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- indexes were dropped with the old table — recreate every existing one
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status_when ON tasks(status, when_type, when_date);
CREATE INDEX idx_tasks_due ON tasks(due_date);
-- new: the delegated view and agent queue polls filter on (assignee, status)
CREATE INDEX idx_tasks_assignee ON tasks(assignee, status);
