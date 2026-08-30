-- 012-project-template: optional template ref on a project (context notepad,
-- 2026-08-30). Mirrors 007-template's task.template — a project may name a
-- template from the punchlist-templates repo that its context notepad "points
-- to"; the existing AI-assisted template editor (tpleditor.js, admin-only,
-- feature-gated) can then be opened for that name, same as it already is for
-- tasks. The value is a free string (a template name) — NOT validated
-- server-side: the templates repo is authoritative and public users may not
-- have it checked out at all.
--
-- Adding a nullable column needs no CHECK change, so a plain ALTER TABLE ADD
-- COLUMN suffices (no projects rebuild).

ALTER TABLE projects ADD COLUMN template TEXT NULL;
