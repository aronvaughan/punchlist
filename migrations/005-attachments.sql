-- 005-attachments: image attachments (attachments design 2026-08-26).
-- A task can carry image files (jpg/png). The TASK references the attachment
-- row here; the bytes live as their own real file in the media dir
-- (PUNCHLIST_MEDIA_DIR, default <PUNCHLIST_DATA>/media), named <id>.<ext>.
--
-- This is a brand-new table (no tasks rebuild), so a plain CREATE TABLE
-- suffices — the runner still snapshots punchlist.db.pre-005 first and wraps
-- this in one transaction. ON DELETE CASCADE means a task's rows vanish with
-- it; the file bytes are unlinked by the API delete path and the reaper.
--
-- retention: 'keep' (default) keeps the file forever; 'on_done' deletes it
-- when the task reaches done/archived. An EXPIRING file is represented by
-- expires_at being non-null (kept out of the CHECK to keep it simple): the
-- reaper deletes it once expires_at <= today. 'keep' + null expires_at = kept.

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,                 -- sanitized display name (never the on-disk path)
  mime        TEXT NOT NULL,                 -- 'image/jpeg' | 'image/png'
  bytes       INTEGER NOT NULL,              -- file size on disk
  retention   TEXT NOT NULL DEFAULT 'keep' CHECK (retention IN ('keep','on_done')),
  expires_at  TEXT NULL,                     -- non-null = expiring (YYYY-MM-DD)
  created_by  TEXT,                          -- actor that uploaded (server-set)
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_attachments_task ON attachments(task_id);
