-- 010-doc-attachments: document attachments — uploaded text docs AND links to
-- local files (document attachments design 2026-08-28). The attachments table
-- gains two additive columns:
--
--   kind  — 'file' (default) for uploaded bytes that live in the media dir as
--           their own file (images and now .md/.txt uploads), or 'link' for a
--           reference to a local document on disk (no bytes stored here).
--   path  — the linked file's absolute (realpath-canonicalized) path, NULL for
--           every upload. Only kind='link' rows set it.
--
-- Uploads keep kind='file' and path NULL, exactly as before. Links carry
-- kind='link', a non-null path, bytes 0, and no media-dir file — the GET route
-- re-validates the path against PUNCHLIST_DOC_ROOTS and streams the file's
-- CURRENT contents so edits to the linked doc show live.
--
-- Both are plain ADD COLUMNs. SQLite allows a column-level CHECK on ADD COLUMN
-- as long as existing rows satisfy it (the DEFAULT 'file' does), so NO table
-- rebuild is needed — a single pair of ALTERs. The runner still snapshots
-- punchlist.db.pre-010 and wraps this in one transaction.

ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file','link'));
ALTER TABLE attachments ADD COLUMN path TEXT NULL;
