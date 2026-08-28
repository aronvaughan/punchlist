// media.js — shared attachment helpers: magic-byte sniffing, mime↔ext mapping,
// on-disk path derivation, and display-filename sanitation. Imported by both
// the API (upload/serve/delete) and the reaper so the rules live in one place.
import { join } from 'node:path';

// Image types — jpg + png. The magic-byte sniff is authoritative for these;
// the declared mime is only a hint.
export const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

// Document (text) types — markdown + plain text. There is no magic-byte
// signature for text, so these are validated by the DECLARED type plus a UTF-8
// text check on the bytes (isUtf8Text) rather than a sniff.
export const DOC_MIME_EXT = { 'text/markdown': 'md', 'text/plain': 'txt' };

// Every mime we can store on disk (images + docs), for ext derivation.
const ALL_MIME_EXT = { ...MIME_EXT, ...DOC_MIME_EXT };

// Normalize a declared content-type to a canonical IMAGE mime we accept, or null.
export function normalizeMime(raw) {
  const m = String(raw || '').split(';')[0].trim().toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg'; // common misspelling
  return m in MIME_EXT ? m : null;
}

// Normalize a declared content-type to a canonical DOCUMENT mime, or null.
// text/x-markdown and a bare .md hint collapse onto text/markdown.
export function normalizeDocMime(raw) {
  const m = String(raw || '').split(';')[0].trim().toLowerCase();
  if (m === 'text/x-markdown' || m === 'text/md') return 'text/markdown';
  return m in DOC_MIME_EXT ? m : null;
}

// Map a .md/.txt file extension to its stored document mime, or null.
export function docMimeForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.md' || e === 'md') return 'text/markdown';
  if (e === '.txt' || e === 'txt') return 'text/plain';
  return null;
}

export const isDocMime = mime => mime in DOC_MIME_EXT;

// Validate that a buffer is real UTF-8 TEXT, not binary masquerading as .md/.txt.
// Rejects NUL bytes (a strong binary signal) and any byte sequence that is not
// well-formed UTF-8 (TextDecoder with fatal:true throws on malformed input).
export function isUtf8Text(buf) {
  if (!buf || buf.length === 0) return false;
  if (buf.includes(0)) return false; // NUL byte — binary, never valid text
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// Magic-byte sniff: JPEG starts FF D8 FF; PNG starts 89 50 4E 47 0D 0A 1A 0A.
// Returns the canonical mime or null (anything unrecognized is rejected 415).
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e &&
      buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  return null;
}

export const extForMime = mime => ALL_MIME_EXT[mime] ?? 'bin';

// The on-disk name is ALWAYS derived from the attachment id + validated mime —
// never from client input, so a hostile filename can't escape the media dir.
export function filePathFor(mediaDir, id, mime) {
  return join(mediaDir, `${id}.${extForMime(mime)}`);
}

// Sanitize a client-supplied display filename: strip any path, drop control
// chars, collapse whitespace, cap length. Used for display + Content-
// Disposition only, never for the disk path. Falls back to a safe default.
export function sanitizeFilename(raw, mime) {
  let name = String(raw ?? '').replace(/[\\/]/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, ''); // no leading dots (hidden / traversal-ish)
  if (name.length > 120) name = name.slice(0, 120);
  if (name) return name;
  return isDocMime(mime) ? `document.${extForMime(mime)}` : `image.${extForMime(mime)}`;
}
