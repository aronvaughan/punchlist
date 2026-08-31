// templates.js — helpers for the AI-assisted template editor.
import { existsSync, readdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

// Split the model's reply into a human note and the revised template markdown.
// Contract (see design doc): optional <<<NOTE..NOTE, required <<<TEMPLATE..TEMPLATE.
export function parseAiReply(raw) {
  const block = (tag) => {
    const m = raw.match(new RegExp(`<<<${tag}\\n([\\s\\S]*?)\\n${tag}(?:\\n|$)`));
    return m ? m[1] : null;
  };
  const draft = block('TEMPLATE');
  if (draft == null) throw new Error('AI reply had no template block');
  return { note: (block('NOTE') ?? '').trim(), draft: draft.replace(/\s+$/, '') };
}

// realpath-containment guard: return `cand` (its realpath) only if it resolves
// inside `rootDir` — a crafted name can never escape the plane's root.
function containedReal(cand, rootDir) {
  if (!existsSync(cand)) return null;
  const realRoot = realpathSync(rootDir);
  const real = realpathSync(cand);
  return (real === realRoot || real.startsWith(realRoot + '/')) ? real : null;
}

// name -> absolute path of the resolved template file, or null. Two planes,
// highest precedence first:
//   instance (<instanceDir>/<name>.md, private)  >  global authored  >  global packs
// So a same-named instance template overrides a global one locally. Only a-z0-9-
// names; every returned path is realpath-contained under its plane's root.
export function resolveTemplatePath(dir, name, { instanceDir } = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  // 1. instance plane (private, wins) — flat <instanceDir>/<name>.md
  if (instanceDir && existsSync(instanceDir)) {
    const hit = containedReal(join(instanceDir, `${name}.md`), instanceDir);
    if (hit) return hit;
  }
  // 2. global plane — <dir>/templates/{authored, packs/*}
  const root = join(dir, 'templates');
  // Defensive: a configured repo dir whose templates/ root is missing must not
  // throw from realpathSync below — degrade to null (→ 404) instead of a 500.
  if (!existsSync(root)) return null;
  const candidates = [join(root, 'authored', `${name}.md`)];
  const packs = join(root, 'packs');
  if (existsSync(packs)) {
    for (const p of readdirSync(packs)) candidates.push(join(packs, p, `${name}.md`));
  }
  for (const c of candidates) {
    const hit = containedReal(c, root);
    if (hit) return hit;
  }
  return null;
}

// Which plane a template resolves from: 'instance' | 'global' | null (missing).
export function templateScope(dir, name, { instanceDir } = {}) {
  if (instanceDir && existsSync(instanceDir) && containedReal(join(instanceDir, `${name}.md`), instanceDir)) {
    return 'instance';
  }
  return resolveTemplatePath(dir, name) ? 'global' : null;
}

export function readTemplate(dir, name, opts = {}) {
  const p = resolveTemplatePath(dir, name, opts);
  return p ? readFileSync(p, 'utf8') : null;
}

// The text-only editing prompt. The model gets NO tools; its only job is to
// return the revised markdown between the delimiters.
export function buildEditPrompt({ name, draft, messages }) {
  const thread = messages.map(m => `${m.role === 'user' ? 'OWNER' : 'YOU'}: ${m.content}`).join('\n\n');
  return [
    `You are editing the punchlist template "${name}". You transform markdown ONLY.`,
    'Do not use any tools. Do not run commands. Return your answer EXACTLY as:',
    '<<<NOTE', 'one sentence describing what you changed', 'NOTE',
    '<<<TEMPLATE', '...the FULL revised template markdown (frontmatter + body)...', 'TEMPLATE',
    '', 'CURRENT TEMPLATE:', draft, '', 'CONVERSATION:', thread,
  ].join('\n');
}

// Default executor: promisified execFile with a hard timeout and captured
// output. Injected as `run` in buildApp; tests pass a stub with the same shape.
// Returns { code, stdout, stderr }; never rejects on a non-zero exit.
export function makeRunner() {
  return ({ cmd, args, cwd, input, timeoutMs = 120000 }) => new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        // A child killed by the `timeout` (or a maxBuffer overflow) reports
        // err.signal (e.g. 'SIGTERM') and a NULL err.code — `?? 0` would mis-map
        // that to SUCCESS, letting callers' `code !== 0` checks (the plt validation
        // gate) pass on a draft that never actually validated. Any error must map
        // non-zero: numeric exit code, else the signal name, else 1. (ENOENT is
        // unaffected — err.code is the truthy string 'ENOENT'.)
        code: err ? (typeof err.code === 'number' ? err.code : (err.signal || 1)) : 0,
        stdout: stdout ?? '',
        // On a spawn failure execFile yields EMPTY stdout/stderr strings, so `||`
        // (not `??`) is required to fall through to err.message — otherwise the real
        // reason (e.g. "spawn plt ENOENT") is lost and callers see a blank error.
        stderr: (stderr || (err ? String(err.message) : '')),
      }));
    if (input != null) {
      // If the child dies before draining stdin (early exit, or a timeout kill mid
      // ~64KB write) the pipe breaks (EPIPE) and stdin emits 'error'. With no
      // listener Node rethrows it as an unhandled stream error, crashing the whole
      // server. Swallow it — the spawn outcome is already captured by the callback.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
