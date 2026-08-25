-- 004-needs-input: the "needs input" primitive (templates PRD 2026-08-25).
-- An agent that gets stuck blocks the task with ONE concrete question instead
-- of guessing; the admin answers and the task returns to active with the
-- answer in context. tasks gains `question`/`answer` and the status CHECK
-- extends to 'blocked'. SQLite can't ALTER a CHECK, so this is a table
-- rebuild (same pattern as 002): new table, copy rows, DROP + RENAME swap.
-- The runner wraps this in one transaction with FKs suspended and verifies
-- PRAGMA foreign_key_check before COMMIT, so steps/task_tags references
-- survive intact (they re-bind to the renamed table by name).

CREATE TABLE tasks_new (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  project_id   TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL CHECK (status IN ('active','in_progress','blocked','review','done','archived')),
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
  assignee     TEXT NOT NULL DEFAULT 'owner',  -- actor names (owner|claude|hermes|email…)
  auto_close   INTEGER NOT NULL DEFAULT 0,    -- finish goes straight to done
  claimed_at   TEXT NULL,                     -- set on claim
  report       TEXT NULL,                     -- agent's outcome note (markdown, notes caps)
  vetted       INTEGER NOT NULL DEFAULT 1,    -- 0 = quarantined from agent execution
  question     TEXT NULL,                     -- the agent's needs-input question (set on block)
  answer       TEXT NULL,                     -- the admin's answer (set on answer)
  CHECK ((when_type IS 'date') = (when_date IS NOT NULL)),
  CHECK (recur IS NULL OR due_date IS NOT NULL)
);

INSERT INTO tasks_new (id, title, notes, project_id, status, when_type, when_date,
                       due_date, due_time, rank, today_rank, recur, spawned_from,
                       created_by, completed_at, created_at, updated_at,
                       assignee, auto_close, claimed_at, report, vetted, question, answer)
  SELECT id, title, notes, project_id, status, when_type, when_date,
         due_date, due_time, rank, today_rank, recur, spawned_from,
         created_by, completed_at, created_at, updated_at,
         assignee, auto_close, claimed_at, report, vetted, NULL, NULL
  FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- indexes were dropped with the old table — recreate every existing one
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status_when ON tasks(status, when_type, when_date);
CREATE INDEX idx_tasks_due ON tasks(due_date);
CREATE INDEX idx_tasks_assignee ON tasks(assignee, status);
