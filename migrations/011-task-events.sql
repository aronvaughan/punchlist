-- 011-task-events: persisted "needs attention" event log (in-app
-- notifications design 2026-08-29). The owner's answer to the webhooks
-- question narrowed scope: the FIRST consumer is punchlist's own web UI, not
-- an external Slack/HTTP target — and delivery must survive a server
-- restart. That means the durable piece from the original webhook design
-- (a persisted queue, not a fire-and-forget in-memory emit) but with the
-- browser as the reader instead of an outbound HTTP POST.
--
-- One row per notable transition (finish->review, block, answer, approve —
-- the same hook points a real outbound-webhook door would use later). `seq`
-- is a plain autoincrementing integer so a client can page with a cheap
-- `WHERE seq > ?` cursor — ULIDs sort correctly but make "give me everything
-- since N" awkward without a second index, and seq is exactly the cursor a
-- polling GET /api/v1/events?since= wants.
--
-- `payload` is a JSON blob (task id/title/status/assignee snapshot at the
-- moment of the event) so the UI can render a toast without a follow-up
-- fetch. `delivered_at` stays nullable and unused by this pass — reserved so
-- a future outbound-webhook delivery worker (the `webhooks` table from the
-- original design, deliberately NOT built here) can mark rows it has already
-- POSTed elsewhere without needing a schema change.
--
-- Brand-new table (no tasks rebuild), so a plain CREATE suffices — the
-- runner still snapshots punchlist.db.pre-011 and wraps this in one
-- transaction. ON DELETE CASCADE means a deleted task's events vanish with
-- it, same as comments/attachments.

CREATE TABLE task_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT NULL
);

CREATE INDEX idx_task_events_task ON task_events(task_id, seq);
