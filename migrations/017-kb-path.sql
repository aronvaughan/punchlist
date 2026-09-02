-- 017: projects and tags gain a kb_path — an absolute local path to a
-- knowledge-base folder, distinct from a project's working_dir (013): where
-- working_dir is the CODE the agent cd's into, kb_path is a place to read
-- background material from and write notes/findings to when a task asks for
-- it. Same shape/validation as working_dir (nullable, path-only, existence
-- not checked — operator-set, never derived from untrusted task content).
ALTER TABLE projects ADD COLUMN kb_path TEXT NULL;
ALTER TABLE tags ADD COLUMN kb_path TEXT NULL;
