-- 007-template: optional template ref on a task (task collaboration, 2026-08-27).
-- A task may name a coding/output template from the punchlist-templates repo;
-- an agent picking the task up `plt show`s it for driving context. The value is
-- a free string (a template name) — NOT validated server-side: the templates
-- repo is authoritative and public users may not have it checked out at all, so
-- the server never rejects an unknown name. GET /api/v1/templates surfaces the
-- available names (read from the templates repo's generated index.json).
--
-- Adding a nullable column needs no CHECK change, so a plain ALTER TABLE ADD
-- COLUMN suffices (no tasks rebuild). The runner snapshots punchlist.db.pre-007
-- and wraps this in one transaction.

ALTER TABLE tasks ADD COLUMN template TEXT NULL;
