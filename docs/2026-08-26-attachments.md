# Image attachments (design + reference)

*Owner-decided 2026-08-26. Punchlist task 01M0YS9VSMNYTS6V4AGKYK77ZG.*

Tasks can carry image attachments (JPEG/PNG). The **task references** an
attachment row; the **bytes live as their own real file** in a separate media
directory — not packed into the SQLite database, and not inlined in JSON.

## Storage layout

- Config: `PUNCHLIST_MEDIA_DIR` (env), default `<PUNCHLIST_DATA>/media`.
  `server.js` creates it at boot; the reaper creates it too.
- Each file is stored as its own file named `<attachment-id>.<ext>`, where the
  extension is derived from the **validated** mime (`jpg` | `png`) — never from
  the client filename. This is the security boundary: a hostile
  `../../etc/whatever` filename can never influence the on-disk path.
- The `attachments` row (migration 005) is the reference; `filename` is a
  sanitized display name only.

## Schema (migration 005)

```sql
CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,     -- sanitized display name (never the disk path)
  mime        TEXT NOT NULL,     -- 'image/jpeg' | 'image/png'
  bytes       INTEGER NOT NULL,
  retention   TEXT NOT NULL DEFAULT 'keep' CHECK (retention IN ('keep','on_done')),
  expires_at  TEXT NULL,         -- non-null = expiring (YYYY-MM-DD)
  created_by  TEXT,              -- uploading actor (server-set)
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
```

A brand-new table (no `tasks` rebuild), so a plain `CREATE TABLE`; the runner
still snapshots `punchlist.db.pre-005` and wraps it in one transaction.
`ON DELETE CASCADE` drops rows if a task is ever deleted; the file bytes are
unlinked by the API delete path and the reaper.

## Validation & limits

- **Types:** JPEG + PNG only. Validated by **both** the declared
  `Content-Type` (a hint) **and** a magic-byte sniff (JPEG `FF D8 FF`, PNG
  `89 50 4E 47 0D 0A 1A 0A`). The sniff is authoritative; a declared mime that
  disagrees, or any other type, is rejected **415**. A text/GIF file renamed to
  `.png` is caught on its bytes.
- **Size:** each file capped at `PUNCHLIST_MAX_UPLOAD_BYTES` (default
  `10485760` = 10MB). Oversize → **413**. This cap is **separate from and larger
  than** the 256KB JSON body cap — the upload route does **not** go through
  `readJson`; it reads the raw body directly.
- Display filename is sanitized (path stripped, control chars removed, capped at
  120 chars) for `Content-Disposition` and the UI only.

## Endpoints (all auth'd, per-actor bearer token)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/tasks/:id/attachments` | Raw-body upload. Body = the image bytes; `Content-Type` declares the mime; `X-Filename` is the display name; `?retention=keep\|on_done` and `?expires_at=YYYY-MM-DD` carry the retention rule. `created_by` is server-set from the token. → **201** with the row metadata. |
| `GET` | `/api/v1/tasks/:id/attachments` | List metadata for a task (no bytes). |
| `GET` | `/api/v1/attachments/:id` | Stream the file inline: `Content-Type` = stored mime, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`. **404** if the row or file is gone. |
| `PATCH` | `/api/v1/attachments/:id` | `{retention?, expires_at?}` — set the retention rule. Uploader or admin only. |
| `DELETE` | `/api/v1/attachments/:id` | Remove row + file. Uploader or admin only (others **403**). |

**Why raw-body, not multipart:** it avoids a multipart parser dependency (Hono
ships none, and the project's invariant is "one runtime dependency, Hono"), and
keeps the large-upload path off the small JSON path cleanly. Uploading is
allowed for any actor — attachments follow the task — with `created_by`
recorded.

### Auth note for the UI

The `GET /api/v1/attachments/:id` stream is under the auth'd `/api/v1/*` tree,
so an `<img src>` (which can't send `Authorization`) can't load it directly. The
web app fetches the bytes **with** the bearer token and shows them via
`URL.createObjectURL` — hence `blob:` is allowed in the CSP `img-src`.

## Retention & the reaper

Each file carries a per-file rule; the default is **keep**:

- `retention = 'keep'`, `expires_at = NULL` — kept forever (default).
- `retention = 'on_done'` — deleted once the owning task reaches
  `done`/`archived`.
- `expires_at` non-null — deleted once `expires_at <= today` (represented by the
  column being non-null; kept out of the CHECK to keep it simple). In the UI
  this is the **Expire…** option.

The reaper (`src/reap.js`, exported `reap({db, mediaDir, today})`) deletes the
file **and** the row for every attachment whose rule has fired, and nothing
else — it is safe to run repeatedly and idempotent. Run it directly
(`node src/reap.js`) or via the wrapper:

```bash
scripts/reap-media.sh   # pins PUNCHLIST_DATA/PUNCHLIST_MEDIA_DIR, logs to
                        # ~/.local/state/punchlist-reap.log
```

### Cron (personal box)

Wired in the claude-config repo, not here: a daily entry in
`~/.claude/setup/directives.json` (`machines.host.crons`) installed by
`setup/register-crons.sh`:

```
20 3 * * * bash $HOME/code/punchlist/scripts/reap-media.sh
```

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PUNCHLIST_MEDIA_DIR` | `<PUNCHLIST_DATA>/media` | Where attachment files live. |
| `PUNCHLIST_MAX_UPLOAD_BYTES` | `10485760` (10MB) | Per-file upload cap. |
| `PUNCHLIST_REAP_LOG` | `~/.local/state/punchlist-reap.log` | Reaper wrapper log path. |

## UI

- **Drawer:** an **Attach image** control (`accept="image/png,image/jpeg"`) plus
  drag-drop onto the drop zone. Attached images render as thumbnail cards
  (lazy-loaded via `IntersectionObserver` + tokened bytes), each with its
  filename, a retention selector (Keep / Delete when done / Expire… date), and a
  delete ✕. Theme-token styling, 44px touch targets, works at 390px.
- **Rows:** a task with attachments shows a small `📎 N` chip on the subline
  (`attachment_count` is included on every task payload).
