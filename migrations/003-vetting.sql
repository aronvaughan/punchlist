-- 003-vetting: provenance vetting (agent-security design 2026-08-24, layer 1).
-- tasks gains `vetted` — 1 = safe for agent execution, 0 = quarantined from
-- agent queues and the claim/finish doors until the admin vets it. A plain
-- ADD COLUMN suffices (no CHECK change, so no table rebuild this time).
--
-- Backfill keys on PROVENANCE, not assignee: every pre-existing row is
-- trusted (vetted=1) EXCEPT rows created by the untrusted 'email' ingest
-- actor, which become vetted=0 — even one assigned to the human (harmless:
-- /complete and PATCH stay open; only agent execution is gated).

ALTER TABLE tasks ADD COLUMN vetted INTEGER NOT NULL DEFAULT 1;

UPDATE tasks SET vetted = 0 WHERE created_by = 'email';

-- agent queue polls filter on (assignee, status, vetted); the existing
-- idx_tasks_assignee (assignee, status) prefix still serves them — no new
-- index needed at this scale.
