// reap.js — attachment retention reaper. Deletes the file bytes + the row for
// every attachment whose retention rule has FIRED, and nothing else:
//   - retention='on_done'  → the owning task is done or archived
//   - expires_at non-null  → expires_at <= today (inclusive)
// 'keep' with a null expires_at is never touched. Safe to run repeatedly.
//
// Run it directly (`node src/reap.js`) or via scripts/reap-media.sh (daily
// cron). Importable too: reap({db, mediaDir, today}) drives the logic for
// tests without touching the filesystem layout.
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './db.js';
import { filePathFor } from './media.js';

// Pure selection + deletion. Returns {deleted:[{id,task_id,reason}], errors}.
export function reap({ db, mediaDir, today = new Date().toLocaleDateString('en-CA'), log = () => {} }) {
  // A row fires when its rule is met. Report the reason for the log trail.
  // kind='file' only: a link stores no bytes and references a file we don't own,
  // so it is never reaped (links are always retention='keep' anyway — this is a
  // belt-and-braces guard so the reaper can never touch a linked document).
  const rows = db.prepare(
    `SELECT a.id, a.task_id, a.mime, a.retention, a.expires_at, t.status AS task_status
       FROM attachments a
       LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.kind = 'file'
        AND ((a.retention = 'on_done' AND t.status IN ('done','archived'))
         OR (a.expires_at IS NOT NULL AND a.expires_at <= ?))`
  ).all(today);

  const deleted = [];
  let errors = 0;
  const del = db.prepare('DELETE FROM attachments WHERE id = ?');
  for (const r of rows) {
    const reason = r.retention === 'on_done' && ['done', 'archived'].includes(r.task_status)
      ? `on_done (task ${r.task_status})` : `expired (${r.expires_at})`;
    try {
      rmSync(filePathFor(mediaDir, r.id, r.mime), { force: true }); // force: ENOENT is fine
      del.run(r.id);
      deleted.push({ id: r.id, task_id: r.task_id, reason });
      log(`reaped ${r.id} [${reason}]`);
    } catch (e) {
      errors++;
      log(`ERROR reaping ${r.id}: ${e.message}`);
    }
  }
  return { deleted, errors };
}

// ---- CLI ----
function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const DATA_DIR = process.env.PUNCHLIST_DATA || join(ROOT, 'data');
  const MEDIA_DIR = process.env.PUNCHLIST_MEDIA_DIR || join(DATA_DIR, 'media');
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
  const { db, migrate } = open(join(DATA_DIR, 'punchlist.db'));
  migrate();
  const stamp = new Date().toISOString();
  const { deleted, errors } = reap({ db, mediaDir: MEDIA_DIR, log: m => console.log(`${stamp} ${m}`) });
  console.log(`${stamp} reap complete: ${deleted.length} deleted, ${errors} error(s)`);
  db.close();
  if (errors) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
