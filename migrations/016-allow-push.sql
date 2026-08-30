-- 016: per-task push authorization. By default agents commit LOCALLY only and
-- never push (the standing rule). The OWNER can lift that for a specific task
-- via the trusted admin door (POST /tasks/:id/allow-push, like vet) — task text
-- can never set it. When allow_push=1, an agent MAY push that task's work.
ALTER TABLE tasks ADD COLUMN allow_push INTEGER NOT NULL DEFAULT 0;
