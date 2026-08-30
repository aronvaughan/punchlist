-- 015-tag-notes: give tags the same "context notepad" projects already have
-- (migrations 001 projects.notes, 012 projects.template). A tag can carry a
-- notes/context blob (a readme agents read for background on everything that
-- tag touches) and, mirroring the project pointer, a free-string `template`
-- name the admin-only AI-assisted template editor (tpleditor.js) can open.
--
-- Ordering per the originating task: root (instance) context, then project
-- context, then tag context — tag notes are injected LAST, after project.
--
-- Nullable/defaulted columns need no CHECK change, so plain ALTER TABLE ADD
-- COLUMN suffices (no tags rebuild).
ALTER TABLE tags ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE tags ADD COLUMN template TEXT NULL;
