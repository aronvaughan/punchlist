#!/usr/bin/env bash
# db-snapshot.sh — WAL-safe backup snapshot (design rev 2, review O2).
# restic must never read the live WAL db; instead we VACUUM INTO an atomic
# snapshot under data/backup/ and restic backs up data/backup/ + data/.env.
# Cron: snapshot at 2:50, restic at 3:00.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AV_TASKS_DATA:-$ROOT/data}"
DB="$DATA_DIR/av-tasks.db"
BACKUP_DIR="$DATA_DIR/backup"
SNAP="$BACKUP_DIR/av-tasks-snapshot.db"

[ -f "$DB" ] || { echo "db-snapshot: no database at $DB" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

# VACUUM INTO refuses to overwrite; write to a temp name, then rename (atomic).
TMP="$SNAP.tmp.$$"
rm -f "$TMP"
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const [db, out] = process.argv.slice(1);
  const d = new DatabaseSync(db, { readOnly: true });
  d.prepare("VACUUM INTO ?").run(out);
  d.close();
' "$DB" "$TMP"
mv -f "$TMP" "$SNAP"
echo "db-snapshot: wrote $SNAP"
