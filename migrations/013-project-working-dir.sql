-- 012: projects gain a working_dir — an absolute local path. On a machine that
-- runs local agents, the sweep cd's into this dir to work the project's tasks
-- against its codebase in place. Nullable; path-only (git remote/branch is
-- discovered from .git when needed). Never derived from untrusted task content.
ALTER TABLE projects ADD COLUMN working_dir TEXT NULL;
