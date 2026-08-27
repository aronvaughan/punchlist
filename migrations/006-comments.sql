-- 006-comments: the activity thread (task collaboration, 2026-08-27).
-- A task is a GitHub-style issue with a typed, append-only, attributed
-- timeline. Comments are the collaboration primitive: agents and humans post
-- 'comment' rows to think out loud / report progress (non-blocking), and every
-- existing lifecycle transition ALSO auto-posts a row here — a readable
-- projection of what happened. The question/answer/report FIELDS on tasks stay
-- the source of truth (their timestamped-concat behaviour is unchanged); these
-- rows are the ordered, human-readable view of the back-and-forth.
--
-- kinds:
--   comment  — a free-form note (the only client-authored kind; POST /comments)
--   question — auto-posted on block, carrying the question text
--   answer   — auto-posted on answer, carrying the answer text
--   report   — auto-posted on finish, carrying the report text
--   status   — auto-posted on claim/complete/approve/archive/reopen/reassign,
--              a terse machine-generated one-liner ("claimed", "approved", …)
--
-- Brand-new table (no tasks rebuild), so a plain CREATE suffices — the runner
-- still snapshots punchlist.db.pre-006 and wraps this in one transaction. ON
-- DELETE CASCADE means a task's timeline vanishes with it.

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT,                          -- actor name (server-set from the token)
  kind       TEXT NOT NULL CHECK (kind IN ('comment','question','answer','report','status')),
  text       TEXT NOT NULL,
  created_at TEXT
);

CREATE INDEX idx_comments_task ON comments(task_id, created_at);
