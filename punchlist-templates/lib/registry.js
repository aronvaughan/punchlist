'use strict';
// The command registry. `bin/plt` no longer names a verb: it scans `lib/*.js`, collects each
// module's `commands` export, and dispatches on the first argv token.
//
// Why: every task that added a subcommand used to edit both `bin/plt` and `lib/spine-cli.js`.
// Two files that every parallel task touches serialize the work and collide. A module that
// wants a verb now exports one descriptor and nothing else in the tree changes.
//
// The descriptor a module exports:
//
//   module.exports = {
//     commands: [{
//       name:    'fan',                                  // the bare verb
//       usage:   'plt fan <plan-file> [--json]',          // the one line `plt help` prints
//       handler: (argv, ctx) => 0,                        // argv AFTER the verb; returns the exit code
//     }],
//   };
//
// `ctx` is `{cwd, env}`. A handler returns the process exit code and never calls
// `process.exit` itself, so a test can call it in-process. It may return a promise; dispatch
// passes the return value straight back and `bin/plt` awaits it. A module with no CLI surface
// exports no `commands` field at all.
const fs = require('fs');
const path = require('path');

const SELF = path.basename(__filename);

function isDescriptor(c) {
  return c && typeof c.name === 'string' && typeof c.handler === 'function';
}

// Adds one descriptor to the map. `from` is the module filename, used in the collision message.
function add(map, c, from) {
  if (!isDescriptor(c)) throw new Error(`bad command descriptor in ${from}: need {name, usage, handler}`);
  const seen = map.get(c.name);
  if (seen) throw new Error(`duplicate command "${c.name}" in ${seen.module} and ${from}`);
  map.set(c.name, { usage: c.usage || `plt ${c.name}`, handler: c.handler, module: from });
}

// discoverCommands(libDir) -> Map<name, {usage, handler, module}>
// Requires every `lib/*.js` under libDir in filename order, so a collision always names the
// earlier file first. Throws on a duplicate verb — two modules claiming one name is a bug that
// must stop the CLI, not resolve silently to whichever file sorted first.
function discoverCommands(libDir) {
  const dir = path.resolve(libDir);
  const map = new Map();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== SELF).sort();
  for (const f of files) {
    let mod;
    try { mod = require(path.join(dir, f)); }
    catch (e) { throw new Error(`cannot load ${path.join(dir, f)}: ${e.message}`); }
    if (!mod || !Array.isArray(mod.commands)) continue;
    for (const c of mod.commands) add(map, c, f);
  }
  return map;
}

// dispatch(argv, {libDir, cwd, env, commands, io}) -> exit code (or a promise of one)
// `commands` is the small set of verbs `bin/plt` still implements in the shim itself; they join
// the discovered map and collide by the same rule, under the module name `<builtin>`.
function dispatch(argv, opts = {}) {
  const io = opts.io || {};
  const write = io.write || ((t) => process.stdout.write(t));
  const error = io.error || ((t) => process.stderr.write(t));
  const cmds = discoverCommands(opts.libDir || __dirname);
  for (const c of opts.commands || []) add(cmds, c, '<builtin>');

  const verb = (argv || [])[0];
  if (!verb || verb === '-h' || verb === '--help' || verb === 'help') {
    for (const name of [...cmds.keys()].sort()) write(cmds.get(name).usage + '\n');
    return 0;
  }
  const found = cmds.get(verb);
  if (!found) { error(`plt: unknown command "${verb}" — plt help\n`); return 2; }
  return found.handler(argv.slice(1), { cwd: opts.cwd || process.cwd(), env: opts.env || process.env });
}

module.exports = { discoverCommands, dispatch };
