-- 009-task-version: optimistic-concurrency token for tasks (concurrency
-- hardening 2026-08-28). Every task mutation bumps this integer in the same
-- transaction as the write; a careful client may pass ?expected_version= (or
-- if_version) to a mutating door and get a 409 instead of clobbering a change
-- it never saw. Omitting it keeps the old last-write-wins behaviour, so this
-- is fully backward-compatible.
--
-- Adding a plain column with a NOT NULL DEFAULT needs NO table rebuild (there
-- is no CHECK to alter), so a single ALTER suffices — existing rows adopt the
-- default (0). The runner still snapshots punchlist.db.pre-009 and wraps this
-- in one transaction.

ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
