-- 001-init: full M0 schema (design rev 2)

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  notes      TEXT NOT NULL DEFAULT '',
  parent_id  TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  domain     TEXT NULL,
  rank       REAL,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  project_id   TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL CHECK (status IN ('active','done','archived')),
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
  CHECK ((when_type IS 'date') = (when_date IS NOT NULL)),
  CHECK (recur IS NULL OR due_date IS NOT NULL)
);

CREATE TABLE steps (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title   TEXT NOT NULL,
  done    INTEGER NOT NULL DEFAULT 0,
  rank    REAL
);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tag_id  TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status_when ON tasks(status, when_type, when_date);
CREATE INDEX idx_tasks_due ON tasks(due_date);
CREATE INDEX idx_steps_task ON steps(task_id);
