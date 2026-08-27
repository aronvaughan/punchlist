-- 008-view-ranks: per-view manual ordering (ordering + backlog design 2026-08-27).
-- Position IS priority (Kanban/Things model). A task can hold a different manual
-- rank in each of the drag-reorderable list views — inbox, agents, human — so
-- the SAME task legitimately sits at a different spot in two views. Today
-- (today_rank) and project sections (tasks.rank) keep their existing ordering
-- columns UNCHANGED; this table is additive.
--
--   view  ∈ inbox | agents | human   (the shared agent backlog uses 'agents')
--   rank  REAL fractional order (between()-minted, renormalized in-tx like the
--         other rank columns); a NULL / absent row sorts LAST behind ranked
--         rows, then the view's natural tiebreak.
--
-- Brand-new table (no tasks rebuild), so a plain CREATE suffices — the runner
-- still snapshots punchlist.db.pre-008 and wraps this in one transaction. ON
-- DELETE CASCADE means a task's manual positions vanish with it.

CREATE TABLE view_ranks (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  view    TEXT NOT NULL,
  rank    REAL,
  PRIMARY KEY (task_id, view)
);

CREATE INDEX idx_view_ranks_view ON view_ranks(view, rank);
