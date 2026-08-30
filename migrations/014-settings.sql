-- 014: instance settings — a small key/value store for instance-level strings:
-- a display name, a global context/directives area injected into agents, the
-- data-governance isolation flag, and backup config. Seeded with safe defaults
-- (private by default; snapshot backups).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT INTO settings (key, value) VALUES
  ('instance_name', ''),
  ('instance_context', ''),
  ('data_isolation', '1'),
  ('backup_mode', 'snapshot'),
  ('backup_repo', '');
