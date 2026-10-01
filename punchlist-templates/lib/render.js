'use strict';
// render — the effort index and the per-run status pages, rendered from state alone: efforts/*.yaml,
// runs/*/{state.yaml,inputs.yaml,events.jsonl,HANDOFF.md} and the `state.facts` snapshot `plt facts`
// keeps. Nothing here shells out to gh; a run whose facts were never collected says so in words.
//
// Pages are deterministic for a given state (the eyebrow stamps the newest event, not the clock),
// so `writeBuild` + `publishManifest` can tell a changed page from an unchanged one by sha alone.
// Output goes to `<processDir>/build/{index.html,run-<id>.html}` and the manifest to
// `<processDir>/build/publish.json`; ignore `process/build/*` except `publish.json` in the
// project's .gitignore — the pages are derived, the manifest carries the published urls.
//
// Every project literal comes from config.links:
//   card       — url template for a card run, `{card}` substituted (`https://tracker.example/{card}`)
//   pr_repo    — `owner/name` for PR urls built from a bare number
//   repo_blob  — optional url template for an effort's relative links, `{path}` substituted
//   board      — optional url of the curated narrative board, named in the index footer
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spine = require('./spine');
const effort = require('./effort');
const effortEvents = require('./effort-events');
const timing = require('./timing');
const yaml = require('./yaml');
const readYaml = (f) => { try { return yaml.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

// Escapes the five characters that change meaning in markup — QUOTES INCLUDED. Escaping only
// `& < >` was enough while every interpolation landed between tags; it stopped being enough the
// moment values went into ATTRIBUTES, where a `"` closes the attribute and whatever follows
// becomes a new one: a reference id of `kb" onmouseover=…` rendered as a live handler. Card ids
// are gated by SAFE_ID, but reference ids, artifact urls, step ids and cycle names are not — and
// no call site should have to know which of them is trusted. The fix belongs to the function.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isUrl = (v) => /^https?:/.test(String(v || ''));
const short = (v) => String(v || '').slice(0, 10);
const stamp = (ts, from = 0) => (ts ? String(ts).slice(from, 16).replace('T', ' ') : '');

const CSS_TOKENS = `:root{--paper:#f2f3ef;--surface:#fff;--surface-2:#e9ebe5;--rule:#c9cdc4;--rule-soft:#dfe2db;--ink:#1b2027;--ink-2:#4a525c;--ink-3:#7a828c;--cycle:#2f5d8a;--cycle-soft:#e3ecf4;--gate:#c4571a;--gate-soft:#f8e6da;--ok:#2e7d4f;--ok-soft:#dff0e4;--warn:#9a6a08;--warn-soft:#f6ecd0;--bad:#b3372c;--bad-soft:#fbe8e6;--disp:"Archivo",-apple-system,BlinkMacSystemFont,sans-serif;--body:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#15181c;--surface:#1c2025;--surface-2:#242930;--rule:#3a414a;--rule-soft:#2c323a;--ink:#e6e8e3;--ink-2:#b2b8bf;--ink-3:#7f878f;--cycle:#7fb0dc;--cycle-soft:#1d2d3d;--gate:#e58a55;--gate-soft:#3a2418;--ok:#6fc48f;--ok-soft:#173224;--warn:#dcb45a;--warn-soft:#33290f;--bad:#f0796c;--bad-soft:#331714}}
:root[data-theme="dark"]{--paper:#15181c;--surface:#1c2025;--surface-2:#242930;--rule:#3a414a;--rule-soft:#2c323a;--ink:#e6e8e3;--ink-2:#b2b8bf;--ink-3:#7f878f;--cycle:#7fb0dc;--cycle-soft:#1d2d3d;--gate:#e58a55;--gate-soft:#3a2418;--ok:#6fc48f;--ok-soft:#173224;--warn:#dcb45a;--warn-soft:#33290f;--bad:#f0796c;--bad-soft:#331714}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55}`;

// ---- the effort index's own design ----------------------------------------------------------
// The index is drawn to the approved design (D9's structure, and the visual language that was
// signed off with it), which is a DIFFERENT token set from the run page's CSS_TOKENS above. Both
// stay: the run page is not this card's to restyle, and sharing one set would have meant either
// renaming the run page's variables or keeping the index off its own palette.
//
// Every colour on the index comes from a token here — no literal in a rule below — and every
// token is redefined twice for dark: once under `prefers-color-scheme` guarded by
// `:not([data-theme="light"])`, so a page stamped light stays light on a dark system, and once
// under `[data-theme="dark"]`, so a page stamped dark is dark on a light system. An unstamped
// page follows the system. `color-scheme` travels with each block so form controls and
// scrollbars follow the palette they are drawn against.
const INDEX_TOKENS = `:root{--bg:#F2F4F0;--panel:#FFFFFF;--panel2:#E9ECE7;--ink:#1B1F1D;--ink2:#5A625E;--ink3:#8A928D;--line:#D6DBD4;--line2:#C3C9C0;--accent:#1F7A6D;--accent-soft:#DDEFEA;--accent-ink:#0F4F45;--working:#B8740F;--working-soft:#F7E9CF;--blocked:#B3402B;--blocked-soft:#F6DCD5;--done:#4E8040;--done-soft:#DCEBD5;--idle:#7A8290;--idle-soft:#E6E9EC;--unknown:#9AA09B;--human:#7E3F8F;--human-soft:#EEDDF2;--scrim:rgba(20,30,25,.28);--on-strong:#FFFFFF;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--sans:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--shadow:0 1px 2px rgba(20,30,25,.06),0 6px 20px rgba(20,30,25,.06);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14181B;--panel:#1C2126;--panel2:#232A30;--ink:#E4E8E2;--ink2:#A7B0A9;--ink3:#727B75;--line:#2E363C;--line2:#3B444B;--accent:#4FB3A2;--accent-soft:#193832;--accent-ink:#9FE0D3;--working:#E0A030;--working-soft:#3A2E14;--blocked:#E06A52;--blocked-soft:#3F211B;--done:#7FBF6E;--done-soft:#20321B;--idle:#8F98A5;--idle-soft:#262C33;--unknown:#6C736E;--human:#C88BD6;--human-soft:#37243C;--scrim:rgba(0,0,0,.5);--on-strong:#14181B;--shadow:0 1px 2px rgba(0,0,0,.4),0 6px 20px rgba(0,0,0,.35);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#14181B;--panel:#1C2126;--panel2:#232A30;--ink:#E4E8E2;--ink2:#A7B0A9;--ink3:#727B75;--line:#2E363C;--line2:#3B444B;--accent:#4FB3A2;--accent-soft:#193832;--accent-ink:#9FE0D3;--working:#E0A030;--working-soft:#3A2E14;--blocked:#E06A52;--blocked-soft:#3F211B;--done:#7FBF6E;--done-soft:#20321B;--idle:#8F98A5;--idle-soft:#262C33;--unknown:#6C736E;--human:#C88BD6;--human-soft:#37243C;--scrim:rgba(0,0,0,.5);--on-strong:#14181B;--shadow:0 1px 2px rgba(0,0,0,.4),0 6px 20px rgba(0,0,0,.35);color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45}`;
// Instrument Sans for prose, JetBrains Mono for ids, paths and commands — each behind a real
// fallback stack in the tokens above, so a page opened with no network still sets in something
// with the same intent rather than in the browser default.
const INDEX_FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">';

const INDEX_CSS = `.frame{max-width:1440px;margin:0 auto;padding:20px 20px 48px}
a{color:var(--accent)}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1,h2,h3{margin:0;text-wrap:balance}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);font-weight:600}
.mono,code{font-family:var(--mono);font-size:12px}
.muted{color:var(--ink2);font-size:12.5px}
.masthead{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}
.masthead h1{font-size:22px;font-weight:600;letter-spacing:-.01em}
.masthead p{margin:4px 0 0;color:var(--ink2);max-width:66ch}
.human,.calm{margin:0 0 16px;padding:12px 14px;border-radius:8px;background:var(--human-soft);border-left:3px solid var(--human);font-size:13.5px}
.calm{background:var(--accent-soft);border-left-color:var(--accent);color:var(--accent-ink)}
.human code,.calm code{font-family:var(--mono);font-size:12px}
.shell{display:grid;grid-template-columns:310px minmax(0,1fr);border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel);box-shadow:var(--shadow);margin:14px 0 8px}
@media (max-width:900px){.shell{grid-template-columns:1fr}.left{border-right:0;border-bottom:1px solid var(--line)}}
.left{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-width:0}
.left .hd{padding:14px 16px 10px;border-bottom:1px solid var(--line)}
.left .hd .title{font-weight:600;font-size:15px}
.left .hd .sub{font-family:var(--mono);font-size:11px;color:var(--ink2);margin-top:2px}
ul.roster{list-style:none;margin:0;padding:0 8px 8px;display:grid;gap:2px}
li.rost.brain{margin:10px 2px 6px;padding:12px;border-radius:8px;background:var(--accent-soft);border:1px solid transparent;display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
li.rost.brain .name{font-weight:600;color:var(--accent-ink);display:flex;gap:8px;align-items:center}
li.rost.brain .src{font-family:var(--mono);font-size:11px;color:var(--accent-ink);opacity:.85}
li.rost.brain .row{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.rollup{display:flex;gap:6px;flex-wrap:wrap}
.rollup span{font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:999px;background:var(--panel);color:var(--ink2)}
.rollup span b{color:var(--ink);font-weight:600}
.rollup span.h{background:var(--human-soft);color:var(--human)}.rollup span.h b{color:var(--human)}
li.rost.brain .ea{font-family:var(--mono);font-size:11px;color:var(--accent-ink)}
.left .lbl{padding:4px 8px 4px}
li.rost{border-radius:7px;border:1px solid transparent;padding:9px 10px 8px;display:grid;grid-template-columns:16px minmax(0,1fr) auto;column-gap:10px;row-gap:4px;align-items:start;font-size:13px}
li.rost:hover{background:var(--panel2)}
li.rost .ico{display:inline-flex;width:16px;height:16px;flex:0 0 16px;margin-top:2px;position:relative}
li.rost .ico svg{display:block}
li.rost .ico .nb{position:absolute;top:-3px;right:-3px;width:8px;height:8px;background:var(--human);transform:rotate(45deg);border:1.5px solid var(--panel)}
.ico.flight .arc{transform-origin:8px 8px;animation:spin 1.1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ico.flight .arc{animation:none}}
li.rost .who{min-width:0;overflow-wrap:anywhere}
li.rost .id{font-family:var(--mono);font-size:11px;color:var(--ink3);display:block}
li.rost .nm{font-weight:500;line-height:1.3;display:block}
li.rost .ea{font-family:var(--mono);font-size:10.5px;color:var(--ink3);display:block;margin-top:1px}
li.rost .st{font-family:var(--mono);font-size:11px;color:var(--ink2);text-align:right;white-space:nowrap}
li.rost[data-state="human"] .st{color:var(--human)}li.rost[data-state="flight"] .st{color:var(--working)}li.rost[data-state="done"] .st,li.rost[data-state="approved"] .st{color:var(--done)}li.rost[data-state="ready"] .st{color:var(--accent)}li.rost[data-state="not-launched"] .st{color:var(--ink3)}
li.rost[data-state="not-launched"]{opacity:.8}
.chips{grid-column:2/4;display:flex;flex-wrap:wrap;gap:4px}
.achip{display:inline-flex;align-items:stretch;border:1px solid var(--line);border-radius:4px;background:var(--panel2);overflow:hidden}
.achip a{font-family:var(--mono);font-size:10.5px;padding:1px 6px;color:var(--ink2);text-decoration:none}
.achip a:hover{background:var(--panel);color:var(--ink)}
.achip a.x{border-left:1px solid var(--line2);padding:1px 5px;font-weight:600;color:var(--accent)}
.achip.pend{border-style:dashed;background:transparent}.achip.pend span{font-family:var(--mono);font-size:10.5px;padding:1px 6px;color:var(--ink3)}
.legend-ico{margin-top:auto;padding:10px 16px 12px;border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;font-size:11.5px;color:var(--ink2)}
.legend-ico .eyebrow{grid-column:1/-1}
.legend-ico span.li{display:flex;gap:8px;align-items:center}
.main{min-width:0;display:flex;flex-direction:column;background:var(--bg)}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
.topbar h2{font-size:15px;font-weight:600}
.topbar .meta{font-family:var(--mono);font-size:11px;color:var(--ink3)}
.body{padding:16px 18px;display:grid;gap:16px;align-content:start;min-width:0}
.overview{display:grid;gap:16px;min-width:0}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;min-width:0}
.panel .ph{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line)}
.panel .ph h3{font-size:13px;font-weight:600}
.panel .ph .meta{font-family:var(--mono);font-size:11px;color:var(--ink3)}
.panel .pb{padding:12px 14px}
.needs-strip{background:var(--human-soft);border-bottom:1px solid var(--line);padding:12px 18px}
.needs-strip .nh{display:flex;align-items:center;gap:10px;color:var(--human);flex-wrap:wrap}
.needs-strip .nh h3{font-size:13.5px;font-weight:600}
.needs-strip .nh .meta{font-family:var(--mono);font-size:11px;opacity:.75;margin-left:auto}
.needs-strip .n{font-family:var(--mono);font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;border:1.5px solid var(--human)}
ul.needs{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px}
li.need{display:grid;grid-template-columns:104px minmax(0,1fr) auto;gap:4px 14px;align-items:start;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--human);border-radius:6px;padding:10px 12px;font-size:13px}
li.need .kind{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--human);padding-top:2px;text-transform:uppercase;letter-spacing:.04em}
li.need .nbody{min-width:0}
li.need .ntitle{font-weight:600}
li.need .nctx{color:var(--ink2);font-size:12.5px;margin-top:2px;max-width:78ch}
li.need .since{font-family:var(--mono);font-size:11px;color:var(--ink3);text-align:right;white-space:nowrap;padding-top:2px}
li.need .since b{color:var(--human);font-weight:600}
li.need code{font-family:var(--mono);font-size:12px;background:var(--panel2);padding:0 4px;border-radius:3px}
li.need[data-need="contention"]{border-left-color:var(--working)}li.need[data-need="contention"] .kind{color:var(--working)}
li.need[data-need="stale-reference"]{border-left-color:var(--idle)}li.need[data-need="stale-reference"] .kind{color:var(--idle)}
li.need[data-need="fan-unavailable"],li.need[data-need="ledger-unreadable"]{border-left-color:var(--blocked);background:var(--blocked-soft)}
li.need[data-need="fan-unavailable"] .kind,li.need[data-need="ledger-unreadable"] .kind{color:var(--blocked)}
@media (max-width:640px){li.need{grid-template-columns:1fr}li.need .since{text-align:left}}
.nempty{margin-top:8px;color:var(--ink2);font-size:13px}
.views{min-width:0}
.tabin{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.tabs{display:flex;gap:4px;background:var(--panel2);padding:3px;border-radius:8px}
.tabs label{padding:5px 12px;border-radius:6px;color:var(--ink2);font-weight:500;font-size:13px;cursor:pointer}
.view{display:none}
.views>.tabin:nth-of-type(1):checked~.ph label[for$="-graph"],.views>.tabin:nth-of-type(2):checked~.ph label[for$="-swim"]{background:var(--panel);color:var(--ink);box-shadow:var(--shadow)}
.views>.tabin:nth-of-type(1):checked~.view[data-view="graph"],.views>.tabin:nth-of-type(2):checked~.view[data-view="swimlanes"]{display:block}
.tabin:focus-visible~.ph label{outline:2px solid var(--accent);outline-offset:2px}
.dagwrap{overflow-x:auto;padding:12px 14px}
svg.dag{display:block;height:auto;font-family:var(--sans)}
svg.dag text{fill:var(--ink)}
svg.dag .wl{fill:var(--ink3);font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
svg.dag .wsep{stroke:var(--line2);stroke-dasharray:3 4}
svg.dag .node rect{fill:var(--panel);stroke:var(--line2);stroke-width:1.2}
svg.dag .node.done rect,svg.dag .node.approved rect{fill:var(--done-soft);stroke:var(--done)}
svg.dag .node.flight rect{fill:var(--working-soft);stroke:var(--working);stroke-width:1.8}
svg.dag .node.human rect{fill:var(--human-soft);stroke:var(--human);stroke-width:1.8}
svg.dag .node.waiting rect{fill:var(--panel);stroke:var(--idle);stroke-dasharray:4 3}
svg.dag .node.ready rect{fill:var(--accent-soft);stroke:var(--accent)}
svg.dag .node.not-launched rect{fill:var(--panel);stroke:var(--unknown);stroke-dasharray:2.2 2}
svg.dag .node .id{font-family:var(--mono);font-size:11px;fill:var(--ink3)}
svg.dag .node .nm{font-size:13px;font-weight:600}
svg.dag .node .tc{font-family:var(--mono);font-size:10.5px;fill:var(--ink2)}
svg.dag .node .ea{font-family:var(--mono);font-size:10.5px;fill:var(--ink3)}
svg.dag .node .st{font-family:var(--mono);font-size:10.5px;font-weight:600;fill:var(--ink2)}
svg.dag .node.done .st,svg.dag .node.approved .st{fill:var(--done)}svg.dag .node.flight .st{fill:var(--working)}svg.dag .node.human .st{fill:var(--human)}svg.dag .node.waiting .st{fill:var(--idle)}
svg.dag a:hover .nm{text-decoration:underline}
svg.dag .wire{fill:none;stroke:var(--ink3);stroke-width:1.4}
svg.dag .wire.done{stroke:var(--done)}
svg.dag .wire.hold{stroke:var(--blocked);stroke-dasharray:2 4}
svg.dag .wire.contend{stroke:var(--idle);stroke-dasharray:2 3}
svg.dag .wlabel{font-family:var(--mono);font-size:10px;fill:var(--ink2)}
svg.dag .wlabel.hold{fill:var(--blocked)}
svg.dag .human-mark{fill:var(--human-soft);stroke:var(--human);stroke-width:1.5}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--ink2);padding:8px 14px;border-top:1px solid var(--line)}
.legend i{display:inline-block;width:18px;border-top:2px solid var(--ink3);vertical-align:middle;margin-right:6px}
.legend i.d{border-color:var(--done)}.legend i.h{border-color:var(--blocked);border-top-style:dotted}.legend i.c{border-color:var(--idle);border-top-style:dotted}
.legend .dm{display:inline-block;width:10px;height:10px;transform:rotate(45deg);border:1.5px solid var(--human);background:var(--human-soft);margin-right:6px;vertical-align:-1px}
ul.graph{list-style:none;margin:0;padding:0 14px 12px}
li.node{padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}li.node:last-child{border-bottom:0}
li.node b{font-family:var(--mono);font-size:12.5px}
.edge{display:inline-block;margin-left:8px;font-size:12px;padding:1px 7px;border-radius:4px;border-left:3px solid var(--line2);background:var(--panel2);color:var(--ink2)}
.edge[data-edge="dependency"]{border-left-color:var(--idle)}
.edge[data-edge="question"]{background:var(--human-soft);border-left-color:var(--human);color:var(--human)}
.edge[data-edge="overlap"]{background:var(--working-soft);border-left-color:var(--working);color:var(--working)}
.edge[data-edge="unknown"]{background:var(--blocked-soft);border-left-color:var(--blocked);color:var(--blocked)}
.clear{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);margin-left:8px}
.wavebands{display:flex;gap:6px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink2)}
.wavebands span{padding:2px 8px;border-radius:4px;background:var(--panel2);font-family:var(--mono);font-size:11px}
.wavebands span.cur{background:var(--working-soft);color:var(--working);font-weight:600}
.wavebands span.past{background:var(--done-soft);color:var(--done)}
.wavebands span.held{background:var(--idle-soft);color:var(--idle)}
.lanes{padding:12px 14px;display:grid;gap:2px;overflow-x:auto}
.lane{display:grid;grid-template-columns:200px minmax(220px,1fr) 110px;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)}
.lane:last-child{border-bottom:0}
.lane b{grid-column:1;font-family:var(--mono);font-size:12px;display:flex;flex-wrap:wrap;gap:3px 8px;align-items:center;min-width:0}
.lane .sm{flex-basis:100%;font-family:var(--mono);font-size:10.5px;color:var(--ink3)}
.lane .eac{grid-column:3;font-family:var(--mono);font-size:11px;color:var(--ink2);text-align:right;white-space:nowrap}
.cells{grid-column:2}
.lane .eac .over{color:var(--blocked)}
.cells{display:flex;gap:2px;min-width:0}
i.cell{display:block;flex:1 1 0;min-width:6px;height:22px;border-radius:4px;background:var(--panel2);border:1px solid var(--line)}
i.cell[data-state="done"],i.cell[data-state="skipped"]{background:var(--done);border-color:var(--done)}
i.cell[data-state="in_progress"]{background:var(--working);border-color:var(--working)}
i.cell[data-state="in_review"]{background:var(--human-soft);border-color:var(--human)}
i.cell[data-state="ready"]{background:var(--accent-soft);border-color:var(--accent)}
i.cell[data-state="blocked"]{background:var(--blocked-soft);border-color:var(--blocked);border-style:dashed}
i.cell[data-state="pending"]{background:transparent;border-style:dashed;border-color:var(--line2)}
@media (max-width:760px){.lane{grid-template-columns:1fr}.lane .eac{text-align:left}}
.two{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:1100px){.two{grid-template-columns:1fr}}
.fanrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-family:var(--mono);font-size:11.5px}
.fanrow a.chip{padding:3px 8px;border-radius:4px;border:1px solid var(--line2);background:var(--panel);text-decoration:none;color:var(--ink2)}
.fanrow a.chip.flight{border-color:var(--working);color:var(--working);background:var(--working-soft)}
.fanrow a.chip.human{border-color:var(--human);color:var(--human);background:var(--human-soft)}
.fanrow a.chip.done,.fanrow a.chip.approved{border-color:var(--done);color:var(--done);background:var(--done-soft)}
.fanrow a.chip.waiting,.fanrow a.chip.not-launched{border-style:dashed}
.arcrow{margin-bottom:10px}.arcrow .eyebrow{margin-bottom:4px;display:block}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12.5px;margin:6px 0 0}
dl.kv dt{color:var(--ink3);font-family:var(--mono);font-size:11px;padding-top:2px}
dl.kv dd{margin:0;color:var(--ink2)}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{text-align:left;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line2)}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.num,.mono{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
tr.done td{opacity:.55}tr.done:hover td{opacity:1}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border-bottom:1px solid var(--line)}
.kpis>div{background:var(--panel);padding:10px 14px}
.kpis .v{font-family:var(--mono);font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.kpis .v.over{color:var(--blocked)}.kpis .v.under{color:var(--done)}
.kpis .l{font-size:11.5px;color:var(--ink2)}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.vb{position:relative;height:14px;min-width:120px}
.vb .e{position:absolute;top:1px;bottom:1px;left:0;border:1.5px dashed var(--ink3);border-radius:3px}
.vb .a{position:absolute;top:4px;bottom:4px;left:0;background:var(--accent);border-radius:2px}
.vb .a.over{background:var(--blocked)}.vb .a.open{background:var(--working)}
tr.roll[data-overrun="true"] td,tr.rolltotal[data-overrun="true"] td{background:var(--blocked-soft)}
tr.rolltotal td{font-weight:600;border-top:1.5px solid var(--line2);border-bottom:0}
.pill{display:inline-block;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:999px}
.pill.ok{background:var(--done-soft);color:var(--done)}
.pill.human{background:var(--human-soft);color:var(--human)}
.pill.wip{background:var(--working-soft);color:var(--working)}
.pill.ready{background:var(--accent-soft);color:var(--accent-ink)}
.pill.wait{background:var(--idle-soft);color:var(--idle)}
.pill.bad{background:var(--blocked-soft);color:var(--blocked)}
.pill.act{background:var(--human-soft);color:var(--human)}
.pill.who-fan{background:var(--idle-soft);color:var(--idle)}
.pill.who-brain{background:var(--accent-soft);color:var(--accent-ink)}
.pill.who-gate{background:var(--human-soft);color:var(--human)}
.decision{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 12px;padding:10px 0;border-bottom:1px solid var(--line)}
.decision:last-child{border-bottom:0}
.decision .t{font-family:var(--mono);font-size:11px;color:var(--ink3);padding-top:2px;white-space:nowrap}
.decision .w{font-size:13px;min-width:0}
.decision .w b{color:var(--accent-ink);font-weight:600}
.decision .w .why{color:var(--ink2);margin-top:2px;font-size:12.5px}
.decision[data-kind="escalation"] .w b{color:var(--human)}
details.doneblock{margin:0}
details.doneblock>summary{cursor:pointer;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);padding:8px 14px;list-style:none}
details.doneblock>summary::-webkit-details-marker{display:none}
details.doneblock>summary::before{content:"\\25b8 "}details.doneblock[open]>summary::before{content:"\\25be "}
details.doneblock>summary:hover{color:var(--ink)}
.detail{display:none}
.detail:target{display:grid;gap:16px;min-width:0}
.detail:target~.overview{display:none}
.detail .back{color:var(--accent);font-weight:600;justify-self:start;text-decoration:none;font-size:12.5px}
.dhead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start}
.dhead h2{font-size:20px;font-weight:600}
.dhead .path{font-family:var(--mono);font-size:11px;color:var(--ink2);margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}
.dhead .path span,.dhead .path a{background:var(--panel2);padding:1px 6px;border-radius:4px}
.dhead .right{display:grid;gap:8px;justify-items:end}
.meter{display:grid;gap:3px;min-width:170px}
.meter .mt{font-family:var(--mono);font-size:11px;color:var(--ink2);text-align:right}
.meter .mt b{color:var(--ink);font-weight:600}.meter .mt b.over{color:var(--blocked)}
.bar{position:relative;height:8px;border-radius:4px;background:var(--panel2);overflow:hidden}
.bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:4px}
.bar i.over{background:var(--blocked)}
.steps{display:flex;align-items:center;gap:0;overflow-x:auto;padding:4px 0}
.step{display:flex;align-items:center;flex:0 0 auto}
.step .b{padding:6px 10px;border-radius:6px;border:1px solid var(--line2);font-family:var(--mono);font-size:11.5px;background:var(--panel)}
.step[data-state="done"] .b,.step[data-state="skipped"] .b{background:var(--done-soft);border-color:var(--done);color:var(--done)}
.step[data-state="in_progress"] .b{background:var(--working-soft);border-color:var(--working);color:var(--working)}
.step[data-state="in_review"] .b{background:var(--human-soft);border-color:var(--human);color:var(--human)}
.step[data-state="ready"] .b{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.step[data-state="blocked"] .b{background:var(--blocked-soft);border-color:var(--blocked);color:var(--blocked)}
.step .g{width:16px;text-align:center;color:var(--ink3);font-size:11px}
.gate{width:12px;height:12px;transform:rotate(45deg);border:1.5px solid var(--human);background:var(--human-soft);margin:0 6px;flex:0 0 auto}
.artlist{display:grid;gap:8px}
.artrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.artrow .an{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--accent);text-decoration:none}
.artrow .at{font-family:var(--mono);font-size:11px;color:var(--ink3);text-align:right}
.artrow.pend{border-style:dashed}.artrow.pend .an{color:var(--ink3)}
.scrim{position:fixed;inset:0;background:var(--scrim);z-index:20;display:block}
.drawer{display:none}
.drawer:target{display:flex;position:fixed;top:0;right:0;bottom:0;width:min(620px,100%);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow);z-index:21;flex-direction:column;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
.dw-h{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:grid;gap:6px;position:relative;z-index:22;background:var(--panel)}
.dw-h .top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dw-h h3{font-size:17px;font-weight:600;font-family:var(--mono)}
.dw-h .pathline{font-family:var(--mono);font-size:11px;color:var(--ink3);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dw-b{flex:1;overflow:auto;padding:16px 18px;position:relative;z-index:22;background:var(--panel)}
.dw-f{border-top:1px solid var(--line);padding:10px 18px;display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;align-items:center;position:relative;z-index:22;background:var(--panel)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:6px;border:1px solid var(--line2);background:var(--panel);font-size:12.5px;font-weight:500;color:var(--ink);white-space:nowrap;text-decoration:none}
.btn:hover{border-color:var(--ink3)}
.btn.acc{background:var(--accent);border-color:var(--accent);color:var(--on-strong)}
.pendbox{border:1px dashed var(--line2);border-radius:8px;padding:16px;color:var(--ink2)}
.foot{margin-top:28px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--ink3);max-width:100ch}
.foot code{font-family:var(--mono);font-size:11.5px}`;

// ---- links from config ----
function links(cfg) {
  const l = (cfg && cfg.links) || {};
  return {
    card: (id) => (l.card ? String(l.card).replace('{card}', encodeURIComponent(id)) : null),
    pr: (num) => (l.pr_repo ? `https://github.com/${l.pr_repo}/pull/${num}` : null),
    prRepo: l.pr_repo || null,
    blob: (p) => (l.repo_blob ? String(l.repo_blob).replace('{path}', p) : null),
    board: l.board || null,
  };
}
const cardAnchor = (L, id) => { const u = L.card(id); return u ? `<a href="${esc(u)}">${esc(id)}</a>` : esc(id); };
const firstHuman = (cfg) => (cfg && cfg.actors && Array.isArray(cfg.actors.humans) && cfg.actors.humans[0]) || '<you>';

// ---- shared per-run reading ----
const runIds = spine.runIds;   // one definition, in lib/spine.js beside readState/readEvents
function currentStep(st) {
  const order = Object.keys(st.steps || {});
  // A blocked step wins: its question is what a person must see, even while another step is current.
  return spine.blockedStep(st) || st.current_step || order.find((s) => ['in_review', 'ready', 'in_progress', 'blocked'].includes(st.steps[s].status)) || null;
}
// The repo a run's PR lives in: `inputs.repo`, else the owner/name inside `inputs.pr`, else the
// config default. A process can watch several repos, so `config.links.pr_repo` is a fallback and
// never the answer when the run says which repo it is about (the same rule as facts.findPrRepo).
function repoOf(inputs, L) {
  if (inputs.repo && /^[^/\s]+\/[^/\s]+$/.test(String(inputs.repo))) return String(inputs.repo);
  const m = String(inputs.pr || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1] : (L.prRepo || null);
}

// The PR a run names: the latest receipt whose ref is a PR url wins (it carries the url itself),
// UNLESS that url is from a different repo than the run declares — a receipt collected against the
// wrong repo is exactly the poison `facts.collect` used to write when one config default served
// every run (a run on repo B collecting repo A's PR of the same number), and the board must not
// repeat it. Else `inputs.pr` as a url or a bare number, built against the run's own repo.
function prOf(events, inputs, L) {
  const repo = repoOf(inputs, L);
  const ours = (ref) => !repo || !isUrl(ref) || String(ref).includes(`/${repo}/pull/`);
  const build = (num) => (repo ? `https://github.com/${repo}/pull/${num}` : L.pr(num));
  const ev = events.filter((e) => e.ref && /pull\/\d+/.test(String(e.ref)) && ours(e.ref)).pop();
  if (ev) { const ref = String(ev.ref); const m = ref.match(/pull\/(\d+)/); return { number: Number(m[1]), url: isUrl(ref) ? ref.replace(/(pull\/\d+).*$/, '$1') : build(m[1]) }; }
  if (inputs.pr) {
    const s = String(inputs.pr);
    const m = s.match(/pull\/(\d+)/) || s.match(/^(\d+)$/);
    if (m) return { number: Number(m[1]), url: isUrl(s) ? s : build(m[1]) };
  }
  if (inputs.pr_number) return { number: Number(inputs.pr_number), url: build(inputs.pr_number) };
  return null;
}
// The facts a page shows, all from state: the `plt facts` snapshot first; else the last `plt run poll`
// snapshot (state.poll.facts — same GitHub fields under gh's names, no check tally); else, for a run
// whose merge step landed (a passing `merged` receipt), MERGED and nothing more. Null means never
// collected, and the page says so.
function factsOf(st, events) {
  if (st.facts) return st.facts;
  const p = st.poll && st.poll.facts;
  if (p && (p.state || p.mergeStateStatus || p.reviewDecision)) {
    return { at: st.poll.at || null, headSha: p.headRefOid || null, state: p.state || null, isDraft: Boolean(p.isDraft),
      reviewDecision: p.reviewDecision || null, mergeStateStatus: p.mergeStateStatus || null, checks: null, threadsUnresolved: null, source: 'poll' };
  }
  if (events.some((e) => e.kind === 'gh' && e.name === 'merged' && e.result === 'pass')) {
    return { at: null, headSha: null, state: 'MERGED', isDraft: false, reviewDecision: null, mergeStateStatus: null, checks: null, threadsUnresolved: null, source: 'receipt' };
  }
  return null;
}
const latestArtifacts = (events) => {
  const out = {};
  for (const e of events) if (e.kind === 'artifact' && e.ref && isUrl(e.ref)) out[e.name] = e.ref;
  return out;
};

// ---- the ONE answer to "main moved under this card" (T26) -------------------------------------
// A merge conflict has TWO repairs and the CARD'S OWN CYCLE picks which. Both pages used to answer
// from a hardcode, and they hardcoded different answers:
//   * the board's needs strip offered `plt card rebase <effort>/<card>` for every DIRTY card;
//   * the run page's merge cell said "the resync step merges it back" for the same condition.
// One of them had to be wrong, and it was the board. `plt card rebase` (lib/rebase.js) rewrites
// every commit of the card's branch in the card's own checkout and NEVER pushes — by design. On a
// PR cycle, following it would have cost the owner the card: the PR stays DIRTY because the rewrite
// was never published, the local branch diverges from the pushed head, `resync`'s "merge, commit and
// push" can no longer fast-forward, and the force-push that would reconcile them is forbidden by
// build-and-ship.md:106 ("never rebase or force-push") — a pushed branch under review cannot be
// rewritten. The board's one suggestion would have stranded the branch and cost the reviewers'
// approvals for nothing.
// The discriminator is the RUN'S STATE, not the cycle's name: `st.steps.resync` exists exactly for
// the runs whose formula declares the merge-in step, so a new cycle that adopts `resync` is routed
// correctly without touching this, and a cycle with no PR falls through to the rebase — which is
// what build-and-commit.md:145 prescribes, with the `merge` step repeating onto the fast-forward.
// The command also has to be RUNNABLE. `spine.stepStart` refuses a step that is not `ready`, and
// only `plt run poll` arms an `arm_on` step, so a resync still pending is named at the poll rather
// than at a start that would throw.
function conflictRepair(st, effortSlug, cardId) {
  const resync = st && st.steps && st.steps.resync;
  if (!resync) {
    return { kind: 'rebase', subject: 'the branch',
      why: 'accept the rebase, and the gates it re-asks',
      command: `plt card rebase ${effortSlug}/${cardId}` };
  }
  const never = 'never a rebase or a force-push — the branch is pushed and under review';
  if (resync.status === 'in_progress') {
    return { kind: 'resync', subject: 'the PR', why: `resync is running — finish it once origin/main is merged in; ${never}`,
      command: `plt step finish resync --run ${cardId} --outcome resynced` };
  }
  if (resync.status === 'ready') {
    return { kind: 'resync', subject: 'the PR', why: `the resync step merges origin/main in; ${never}`,
      command: `plt step start resync --run ${cardId}` };
  }
  return { kind: 'resync', subject: 'the PR', why: `the poll arms resync, which merges origin/main in; ${never}`,
    command: `plt run poll ${cardId}` };
}

function loadRun(processDir, id, cfg, L) {
  const st = spine.readState(processDir, id);
  const inputs = spine.readInputs(processDir, id);
  const events = spine.readEvents(processDir, id);
  const order = Object.keys(st.steps || {});
  const cur = currentStep(st);
  // A run closed through the discard exit reads `discarded` — a dropped card, not a finished one.
  const status = st.status === 'closed' ? (st.closed_as === 'discarded' ? 'discarded' : 'closed')
    : st.exit ? (cur ? st.steps[cur].status : 'pending')
      : cur ? st.steps[cur].status : (order.every((s) => st.steps[s].status === 'done') ? 'done' : 'pending');
  // A ready step whose requirements carry a human gate is the owner's to start — waiting on a person too.
  // A loop step (`repeat_until`) between rounds has nothing to approve until the next one arrives:
  // it waits, not "needs you". spine.betweenRounds is the one predicate nextCommand and the menu use too.
  const betweenRounds = status === 'ready' && Boolean(cur) && spine.betweenRounds(st, events, cur);
  const ownerReady = !betweenRounds && status === 'ready' && cur && (st.steps[cur].receipts_required || []).some((r) => r.kind === 'gate');
  // Waiting on others: nothing is ready or in flight, the run is not complete, and what remains is armed
  // by live facts (`arm_on`) — the author's reply, a moved head, the PR landing. Not anyone's step here.
  let formula = null;
  try { formula = st.cycle ? spine.loadFormula(processDir, st.cycle) : null; } catch (e) { formula = null; }
  const armed = formula ? formula.steps.filter((d) => d.arm_on && st.steps[d.id] && st.steps[d.id].status === 'pending') : [];
  const curDef = formula && cur ? formula.steps.find((d) => d.id === cur) : null;
  const waiting = betweenRounds ? [(curDef && curDef.waiting) || `the next ${cur}`]
    : !cur && status === 'pending' && armed.length ? armed.map((d) => d.waiting || d.id) : null;
  // Poll-derived facts (state.poll.facts, from `plt run poll`): our approval on a PR we reviewed is a fact
  // GitHub can withdraw, never a status — a waiting run whose approval stands gets its own lane, and a
  // dismissed approval is named on the row so the re-arming of re-review reads as what it is.
  const live = (st.poll && st.poll.facts) || {};
  const approved = Boolean(waiting && live.ourApprovalStanding);
  const dismissed = Boolean(live.ourApprovalDismissed && st.cycle === 'review-pr' && !['closed', 'discarded'].includes(status));
  // NEW ACTIVITY on a review we have already posted. `reviewFacts` derives these on every poll;
  // until now they only fed the `waiting` phrasing, so a reply or a push looked the same as silence
  // on the board. They are the one thing on a review row the owner must actually see.
  const posted = Boolean(events.find((e) => e.kind === 'gh' && e.name === 'review-posted'));
  const activity = (posted && !['closed', 'discarded'].includes(status)) ? [
    live.authorRepliedSinceOurReview ? 'replied' : null,
    live.headMovedSinceOurReview ? 'pushed' : null,
    live.ourApprovalDismissed ? 'approval dismissed' : null,
    live.prClosed ? 'PR closed' : null,
  ].filter(Boolean) : [];
  const lane = status === 'in_review' || status === 'blocked' || ownerReady ? 'human'
    : status === 'done' || status === 'closed' || status === 'discarded' ? 'done'
      : status === 'in_progress' ? 'flight' : approved ? 'approved' : waiting ? 'waiting' : 'ready';
  const me = firstHuman(cfg);
  const discardEv = events.find((e) => e.what === 'discarded') || {};
  const next = betweenRounds ? `nothing for you — waiting on ${waiting.join(', or ')}`
    : status === 'in_review' ? `plt gate approve ${id} ${cur} --by human:${me}`
    : status === 'in_progress' ? `plt step finish ${cur} --run ${id} --outcome <outcome>`
      : status === 'ready' ? (ownerReady ? `plt gate approve ${id} ${cur} --by human:${me}  (review the page first)` : `plt step start ${cur} --run ${id}`)
        : status === 'blocked' ? `answer the question on ${cur}${spine.openQuestion(events, cur) ? `: ${spine.openQuestion(events, cur)}` : ''}`
          : status === 'closed' ? 'closed'
            : status === 'discarded' ? `discarded — ${discardEv.reason || 'no reason recorded'}${discardEv.replaced_by ? ' · replaced by ' + discardEv.replaced_by : ''}`
              : approved ? `Approved by us on ${String(live.ourApprovalSha || '').slice(0, 7) || '?'}${live.ourApprovalOnHead === false ? ' (head has moved)' : ''} · waiting on the author to merge`
                : waiting ? `nothing for you — waiting on ${waiting.join(', or ')}` : 'run complete';
  const rr = st.steps['re-review'];
  const dismissedNote = dismissed ? `approval dismissed by a new push — ${rr && rr.status === 'ready' ? 're-review armed' : rr && rr.status === 'in_progress' ? 're-review in progress' : 'waiting on the poll to arm re-review'}` : null;
  const done = order.filter((s) => ['done', 'skipped'].includes(st.steps[s].status)).length;
  const pr = prOf(events, inputs, L);
  const facts = factsOf(st, events);
  const artifacts = latestArtifacts(events);
  const ourReview = events.filter((e) => e.kind === 'gh' && e.name === 'review-posted' && e.result === 'pass').pop();
  return { id, st, inputs, events, cur, status, lane, activity, pollAt: (st.poll && st.poll.at) || null, next, done, total: order.length, last: events[events.length - 1], pr, facts, artifacts, ourReview, waiting, approved, dismissedNote,
    gates: events.filter((e) => e.kind === 'gate').length, reprompts: events.filter((e) => e.kind === 'reprompt').length,
    extrapolations: events.filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.scope !== 'none').length,
    outOfBand: events.filter((e) => e.out_of_band === true).length };
}

// ---- the effort index ----
const laneOrder = ['human', 'flight', 'ready', 'waiting', 'approved', 'done'];
const pill = (lane) => ({ human: 'human', flight: 'wip', ready: 'ready', waiting: 'wait', approved: 'ok', done: 'ok' })[lane];
// A commit-review cycle approves `pre-commit-summary`, not `pre-pr-summary`. Without it
// here the run page said "not yet published" for the exact page `approve` was waiting on,
// and the effort index had no link to it — the owner's dashboard could not reach the
// document the gate asks them to read.
const PAGE_LINKS = [['dispatch-brief', 'brief'], ['pre-pr-summary', 'pre-PR'], ['pre-commit-summary', 'pre-commit'], ['review-outbound', 'review'], ['fix-summary', 'fix'], ['review-response', 'replies']];

// ---- the effort panel ----
// One panel per effort: a shared left roster (the brain, then the cards) beside two tabs — the
// fan-out GRAPH, which answers "why is this card waiting", and the cycle SWIMLANES, which answer
// "how far along is it". The split is the point: switching tabs changes only the picture, so the
// roster lives outside the tabbed views and never moves.
//
// The tabs are two radio inputs and a label each. No script: the page is written to disk and
// served as a file, and a board that needs JavaScript to show its second half is a board that
// shows half of itself when anything goes wrong.
const domId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '-');

// The state icon is a DRAWING, one per lane, and the drawing carries the meaning on its own: a
// filled check for done, a ring with a running arc for a step in flight, a barred disc for a card
// that stopped and wants a person, a dashed ring for a card nothing has launched. Every fill is a
// token, so the icon set follows the theme; the `title`/`aria-label` says the same thing in words,
// because a legend at the bottom of a column is no help to a screen reader in the middle of it.
const STATE_WORDS = {
  human: 'needs a person', flight: 'in flight', ready: 'ready to start', waiting: 'waiting on others',
  approved: 'approved by us, waiting on the author', done: 'finished', 'not-launched': 'not launched',
};
const GLYPH = {
  done: '<circle cx="8" cy="8" r="7" fill="var(--done)"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--panel)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  approved: '<circle cx="8" cy="8" r="7" fill="none" stroke="var(--done)" stroke-width="1.8"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--done)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  flight: '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--working-soft)" stroke-width="2.4"/><path class="arc" d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="var(--working)" stroke-width="2.4" stroke-linecap="round"/>',
  human: '<circle cx="8" cy="8" r="7" fill="var(--human)"/><rect x="4" y="7" width="8" height="2" rx="1" fill="var(--panel)"/>',
  ready: '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" stroke-width="1.8"/><circle cx="8" cy="8" r="2.4" fill="var(--accent)"/>',
  waiting: '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--idle)" stroke-width="1.8"/><rect x="5.6" y="5.2" width="1.6" height="5.6" fill="var(--idle)"/><rect x="8.8" y="5.2" width="1.6" height="5.6" fill="var(--idle)"/>',
  'not-launched': '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--unknown)" stroke-width="1.6" stroke-dasharray="2.2 2"/>',
  brain: '<circle cx="8" cy="8" r="7" fill="var(--accent)"/><circle cx="8" cy="8" r="2.6" fill="var(--accent-soft)"/>',
};
function ico(state, needsYou) {
  const label = (STATE_WORDS[state] || state) + (needsYou ? ' · needs you' : '');
  return `<span class="ico ${esc(state)}" role="img" aria-label="${esc(label)}" title="${esc(label)}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${GLYPH[state] || GLYPH['not-launched']}</svg>${needsYou ? '<i class="nb"></i>' : ''}</span>`;
}

// The effort ledger. A MISSING one is the ordinary state of a young effort and reads as no events;
// an UNREADABLE one is a different fact and must say so, because the alternative — the shape this
// had first — is a panel reporting "0 decided alone" for a ledger it could not open. A count of
// zero and a count nobody could take are not the same answer, and only one of them is reassuring.
function effortLedger(processDir, slug) {
  try { return { events: effortEvents.readEffortEvents(processDir, slug), error: null }; }
  catch (e) { return { events: [], error: e.message }; }
}

// ELAPSED for a run, projected by lib/timing from the `kind: time` events the ledger already
// carries — and, as important, WHETHER the ledger can evidence one at all. Three states, never two:
//
//   measured  — every span this run opened has closed. The number is the elapsed.
//   open      — a span is still running. Measured to the run's last event the number is a LOWER
//               BOUND, so a step open since Monday reads 0m on Friday. It is reported as `≥`.
//   none      — no `time` events at all. That is NOT zero, and printing zero here is how a
//               launched card that nobody has touched came to read as inside its budget.
//
// `now` is the run's newest event, never the wall clock: this page is deterministic for a given
// state — publishManifest tells a changed page from an unchanged one by sha alone — and an open
// span measured against the clock would make every render a new page to republish.
function actualOf(r) {
  const order = Object.keys(r.st.steps || {});
  const t = r.last ? Date.parse(r.last.ts) : NaN;
  const rows = timing.timingTable(r.events, { order, now: Number.isFinite(t) ? t : 0 });
  const seen = rows.filter((row) => row.spans > 0);
  if (!seen.length) return { ms: null, open: false, why: 'no time events on this run' };
  return { ms: rows.reduce((a, row) => a + row.elapsed_ms, 0), open: seen.some((row) => row.open),
    why: seen.some((row) => row.open) ? 'a step is still open — this is a lower bound' : null };
}
// What the roster and the roll-up print for an actual. `—` is never enough on its own here: the
// reader has to be told there is no data rather than left to read a dash as a small number.
function actualText(a) {
  if (!a) return 'not started';
  if (a.ms === null) return 'no data';
  return `${a.open ? '≥ ' : ''}${timing.humanMs(a.ms)}`;
}

// The steps a card's swimlane is ruled by — ITS OWN cycle, not one ruler for the effort. A launched
// card rules itself on its state's steps; an unlaunched one on its cycle's formula. A five-step
// ruler is fine for a spike and squashes build-and-ship, which has 13.
function rulerFor(processDir, card, r) {
  const gated = (reqs) => (reqs || []).some((q) => q.kind === 'gate');
  if (r) return Object.keys(r.st.steps || {}).map((id) => ({ id, state: r.st.steps[id].status, gate: gated(r.st.steps[id].receipts_required) }));
  // An unlaunched card is ruled by its FORMULA, where a human gate is still `gate.kind: human` —
  // `receipts_required` is compiled at launch and does not exist yet.
  try { return spine.loadFormula(processDir, card.cycle).steps.map((d) => ({ id: d.id, state: 'pending', gate: Boolean(d.gate && d.gate.kind === 'human') })); }
  catch (e) { return []; }
}

// Why a card is held, as planWave says it. planWave joins one clause per reason with '; ', and the
// overlap clause is the only one shaped `touches <paths> — shared with <card>`. This reads lib/effort's
// own sentence rather than recomputing the rule a second way: two implementations of "do these cards
// collide" is exactly how a board comes to disagree with the fan it is drawing.
const OVERLAP_CLAUSE = /^touches (.+) — shared with (.+)$/;
const DEP_CLAUSE = /^after \S+|is not a card of this effort/;
function holdsFor(wave, cardId) {
  const row = wave && wave.excluded.find((x) => x.card === cardId);
  if (!row) return [];
  return String(row.why || '').split('; ').map((clause) => {
    const ov = clause.match(OVERLAP_CLAUSE);
    if (ov) return { kind: 'overlap', from: ov[2], path: ov[1], text: clause };
    const dep = clause.match(/^after ([^\s,]+)/) || clause.match(/^(\S+) is not a card of this effort/);
    if (DEP_CLAUSE.test(clause)) return { kind: 'dependency', from: dep ? dep[1] : null, text: clause };
    return { kind: 'other', from: null, text: clause };
  });
}

// A card's edges: dependency, open question, file overlap — the three labelled kinds the panel draws.
// A launched card is past the fan, so its one remaining reason to wait is a question nobody answered.
function edgesFor(card, r, wave) {
  if (r) {
    if (r.status !== 'blocked') return [];
    const q = spine.openQuestion(r.events, r.cur);
    return [{ kind: 'question', from: null, text: `open question on ${r.cur}${q ? `: ${q}` : ''}` }];
  }
  return holdsFor(wave, card.id).filter((h) => h.kind !== 'other');
}


// estimate vs actual. An estimate is in `ideal_days`; elapsed is calendar hours, so comparing them
// needs a stated conversion rather than a silent one — `estimation.hours_per_day`, 8 unless the
// project says otherwise. The two are different measures; naming
// the conversion on the page is the honest way to put them in one column.
// A reference's staleness window — `references.stale_after`, `14d` unless the project says
// otherwise. Measured against the newest event on the board rather than the clock, for the
// same reason the elapsed is: this page must render the same twice.
const DURATION = /^(\d+)\s*([hdw])$/;
function staleAfterMs(cfg) {
  const raw = String((cfg && cfg.references && cfg.references.stale_after) || '14d').trim();
  const m = raw.match(DURATION);
  if (!m) return 14 * 86400000;
  return Number(m[1]) * ({ h: 3600000, d: 86400000, w: 7 * 86400000 })[m[2]];
}
// The references an effort declares, with how long ago each was indexed. `references:` is the
// effort file's own list; an effort with none produces no items, which is the
// state of every effort today — an empty strip is the honest answer, not a placeholder.
// Three outcomes, and only the first is silence:
//   fresh         — indexed inside the window. No item.
//   stale         — indexed longer ago than the window. An item, with the date.
//   never-indexed — declared with no `last_indexed`. The STALEST possible reference, and the first
//                   shape of this filtered it out: a reference nobody has ever indexed said nothing
//                   at all, which is the opposite of the rule this strip enforces:
//                   staleness is always reported.
//   unmeasurable  — the board carries no event to measure against (a fresh effort, before anything
//                   has run). Every reference is then unchecked, not fresh — and a fresh effort is
//                   exactly when a plan is being written against those references.
function staleReferences(e, cfg, nowTs) {
  const cut = staleAfterMs(cfg);
  const now = Date.parse(nowTs || '');
  return (Array.isArray(e.references) ? e.references : [])
    .map((v) => (typeof v === 'string' ? { id: v } : v || {}))
    .filter((v) => v && v.id)
    .map((v) => {
      const at = Date.parse(v.last_indexed || '');
      if (!Number.isFinite(at)) return { ...v, why: 'never-indexed' };
      if (!Number.isFinite(now)) return { ...v, why: 'unmeasurable' };
      return { ...v, age: now - at, why: now - at > cut ? 'stale' : 'fresh' };
    })
    .filter((v) => v.why !== 'fresh');
}

const hoursPerDay = (cfg) => { const v = Number(cfg && cfg.estimation && cfg.estimation.hours_per_day); return Number.isFinite(v) && v > 0 ? v : 8; };
// A launched card's estimate carries the unit it was launched with. An UNLAUNCHED card's is a bare
// number in the effort file, and the unit that number is in is `estimation.unit` — the same key
// spine.launchRun stamps onto a run. Defaulting it to ideal_days regardless printed a project on
// `unit: hours` a figure eight times too large for every card it had not started yet.
function estimateOf(card, r, cfg) {
  const projectUnit = (cfg && cfg.estimation && cfg.estimation.unit) || 'ideal_days';
  if (r && r.st.estimate && Number.isFinite(Number(r.st.estimate.value))) return { value: Number(r.st.estimate.value), unit: r.st.estimate.unit || projectUnit };
  if (card && Number.isFinite(Number(card.estimate))) return { value: Number(card.estimate), unit: projectUnit };
  return null;
}
// An estimate's UNIT decides its conversion — `estimation.unit` is a config key, `ideal_days` is
// only its default, and the unit was being ignored: a project on `unit: hours` had its hours
// multiplied by hours-per-day and printed four times too large, in the column beside one that
// spelled the unit out correctly. A unit this does not know converts to NOTHING rather than to a
// plausible wrong number; the row then reads unknown, which is true.
const DAY_UNITS = ['ideal_days', 'ideal days', 'days', 'day', 'd'];
const HOUR_UNITS = ['ideal_hours', 'ideal hours', 'hours', 'hour', 'h'];
const MINUTE_UNITS = ['minutes', 'minute', 'mins', 'min', 'm'];
function estimateMs(est, hpd) {
  if (!est || !Number.isFinite(est.value)) return null;
  const u = String(est.unit || '').trim().toLowerCase();
  if (DAY_UNITS.includes(u)) return est.value * hpd * 3600000;
  if (HOUR_UNITS.includes(u)) return est.value * 3600000;
  if (MINUTE_UNITS.includes(u)) return est.value * 60000;
  return null;
}
// The verdict, and it refuses to be cheerful about missing data. `unknown` unless the ledger can
// carry the claim: no estimate, no measured actual, or a unit nothing can convert. The one case an
// OPEN span can still settle is an over-run — a lower bound already past the estimate is past it,
// however much longer the step runs — so that stays `true` rather than being thrown away.
function overrunOf(act, estMs) {
  if (estMs === null || !act || act.ms === null) return 'unknown';
  if (act.ms > estMs) return 'true';
  return act.open ? 'unknown' : 'false';
}

function renderIndex(processDir, cfg) {
  cfg = cfg || spine.loadConfig(processDir);
  const L = links(cfg);
  const effortsDir = path.join(processDir, 'efforts');
  const efforts = fs.existsSync(effortsDir) ? fs.readdirSync(effortsDir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => readYaml(path.join(effortsDir, f))).filter(Boolean) : [];
  const ids = runIds(processDir);
  const runs = Object.fromEntries(ids.map((id) => [id, loadRun(processDir, id, cfg, L)]));
  const runPage = (r) => r.artifacts['run-' + r.id] || null;
  const runLink = (r) => (isUrl(r.inputs.pr) ? String(r.inputs.pr) : L.card(r.id));
  const prCell = (r) => {
    if (!r.pr) return '—';
    const f = r.facts;
    const head = r.pr.url ? `<a href="${esc(r.pr.url)}">#${r.pr.number}</a>` : `#${r.pr.number}`;
    const state = f ? esc(f.state === 'MERGED' ? 'MERGED' : (f.reviewDecision || f.state || '')) : 'not collected yet';
    const conflict = f && f.mergeStateStatus === 'DIRTY' ? ' <span class="pill bad">🔀 conflict</span>' : '';
    // Only link it when the receipt carries a url. A `review-posted` receipt whose ref is a bare
    // sha would otherwise render as a relative href and 404 on the board.
    const ours = r.ourReview ? (isUrl(r.ourReview.ref)
      ? ` · <a href="${esc(r.ourReview.ref)}">our review posted</a>`
      : ' · <span class="muted">our review posted</span>') : '';
    const act = (r.activity && r.activity.length)
      ? ` <span class="pill act">⚡ ${esc(r.activity.join(' · '))}</span>` : '';
    return `${head} ${state}${conflict}${act}${ours}`;
  };
  const runRow = (r) => `<tr class="${r.lane === 'done' ? 'done' : ''}"><td>${runLink(r) ? `<a href="${esc(runLink(r))}">${esc(r.id)}</a>` : esc(r.id)}<br><span class="muted">${esc(r.inputs.title || '')}</span></td>
<td>${runPage(r) ? `<a href="${esc(runPage(r))}">status page</a>` : '<span class="muted">not published</span>'}</td>
<td><span class="pill ${pill(r.lane)}">${esc(r.approved ? 'approved' : r.waiting ? 'waiting' : r.status)}</span> · ${esc(r.approved ? 'by us · author to merge' : r.waiting ? 'on others' : (r.st.exit && r.status !== 'discarded' ? `${r.st.exit}:${r.cur || '—'}` : (r.cur || '—')))}${r.dismissedNote ? `<br><span class="pill bad">dismissed</span> <span class="muted">${esc(r.dismissedNote)}</span>` : ''}</td><td class="num">${r.done}/${r.total}</td>
<td>${prCell(r)}</td>
<td class="mono">${esc(r.next)}</td>
<td>${PAGE_LINKS.filter(([k]) => r.artifacts[k]).map(([k, label]) => `<a href="${esc(r.artifacts[k])}">${label}</a>`).join(' · ') || '—'}</td>
<td class="num">${r.gates}g · ${r.reprompts}r · ${r.extrapolations}x${r.outOfBand ? ` · ${r.outOfBand}o` : ''}</td>
<td class="mono">${r.last ? esc(stamp(r.last.ts, 5)) : ''}</td></tr>`;

  // The wave is computed ONCE per effort and handed to everything that draws it — the bands, the
  // graph's overlap edges, the Arc panel and the needs strip. Computing it twice invites two
  // answers on one page.
  const effortLink = (k, v) => {
    const u = isUrl(v) ? String(v) : L.blob(String(v));
    return u ? `<a href="${esc(u)}">${esc(k)}</a>` : `${esc(k)}: <code>${esc(v)}</code>`;
  };
  const effortBlock = (e) => {
    const cardIds = (e.cards || []).map((c) => (typeof c === 'string' ? c : c.id));
    // A dropped card stays on the board with its run: `dropped:` entries are ids or { id, reason, replaced_by }.
    const droppedIds = (e.dropped || []).map((d) => (typeof d === 'string' ? d : d && d.id)).filter(Boolean);
    const its = [...cardIds, ...droppedIds.filter((d) => !cardIds.includes(d))].map((c) => runs[c]).filter(Boolean);
    const unlaunched = cardIds.filter((c) => !runs[c]);
    const open = (e.decisions || []).filter((d) => d.status !== 'settled');
    // The cards as the spine reads them — ids normalized, cycle defaulted, touches trimmed. A card
    // this rejects would throw on `plt effort plan`; here it must not take the board down, so the
    // panel falls back to the raw entries and the rest of the page still renders.
    const cards = (() => {
      try { return effort.normalizeCards(e.cards || [], effort.defaultCycle(processDir)); }
      catch (err) { return (e.cards || []).map((c) => (typeof c === 'string' ? { id: c } : c)).filter((c) => c && c.id).map((c) => ({ touches: [], after: [], ...c })); }
    })();
    // A wave that could not be computed is NOT a wave with nothing in it. One malformed card id and
    // planWave throws; swallowing that made every node read `clear` — the graph asserting that
    // nothing is waiting, which is the single question that view exists to answer.
    let wave = null; let waveError = null;
    try { wave = effort.planWave(processDir, e.slug); } catch (err) { waveError = err.message; }
    const { events: ledger, error: ledgerError } = effortLedger(processDir, e.slug);
    const epoch = ledger.filter((v) => v.kind === 'epoch').length;
    const brainDecisions = ledgerError ? null : ledger.filter((v) => v.kind === 'decision' && v.who === 'brain' && v.gate_epoch === epoch).length;

    // The roster: the brain first — it is the actor above the cards, and the entry that says what it
    // decided alone since the last gate closed — then one entry per card, then any run with no card
    // entry left, which is a real state (a dropped card keeps its run) and must not vanish.
    const detailId = (id) => `d-${domId(e.slug)}-${domId(id)}`;
    const artId = (id, k) => `art-${domId(e.slug)}-${domId(id)}-${domId(k)}`;
    // An artifact chip is two halves, as the design draws it: the NAME opens the artifact's own
    // panel on this page (a `:target` drawer, so it works with no script at all), and the arrow is
    // the artifact itself, off-site. A launched run that has published nothing gets the dashed
    // chip instead of an empty gap — the difference between "none yet" and "none" is the whole
    // point of the roster.
    const achips = (r) => {
      if (!r) return '';
      const have = PAGE_LINKS.filter(([k]) => r.artifacts[k]);
      if (!have.length) return '<span class="achip pend"><span>no artifact published yet</span></span>';
      return have.map(([k, label]) => `<span class="achip"><a href="#${esc(artId(r.id, k))}">${esc(label)}</a><a class="x" href="${esc(r.artifacts[k])}" title="${esc(k)} — open the published page">↗</a></span>`).join('');
    };
    const stepWord = (r) => (!r ? 'no run in the ledger'
      : r.approved ? 'approved · author to merge'
        : r.waiting ? `waiting · ${r.waiting.join(', or ')}`
          : `${r.status}${r.cur ? ` · ${r.cur}` : ''}`);
    const rosterEntry = (c, source) => {
      const r = runs[c.id];
      const state = r ? r.lane : 'not-launched';
      const est = estimateOf(c, r, cfg);
      const act = r ? actualOf(r) : null;
      const over = act && act.ms !== null && estimateMs(est, hoursPerDay(cfg)) !== null && act.ms > estimateMs(est, hoursPerDay(cfg));
      const ea = `est ${est ? `${esc(est.value)} ${esc(String(est.unit).replace(/_/g, ' '))}` : 'none'} · act <b${over ? ' class="over"' : ''}>${esc(actualText(act))}</b>`;
      const title = c.title || (r && r.inputs.title) || '';
      return `<li class="rost" data-rost="${esc(c.id)}" data-state="${esc(state)}" data-source="${esc(source)}" data-actual="${act && act.ms !== null ? (act.open ? 'lower-bound' : 'measured') : 'none'}">${ico(state, Boolean(r && r.lane === 'human'))}<span class="who"><span class="id">${cardAnchor(L, c.id)} <span class="src">${esc(source)}</span></span><a class="nm" href="#${esc(detailId(c.id))}">${esc(title || c.id)}</a><span class="ea">${ea}</span></span><span class="st">${esc(r ? r.lane : 'not launched')}<br><span>${esc(stepWord(r))}</span></span>${achips(r) ? `<span class="chips">${achips(r)}</span>` : ''}</li>`;
    };
    const rosterIds = new Set(cards.map((c) => c.id));
    const laneCount = (l) => its.filter((r) => r.lane === l).length;
    const rosterHead = `<div class="hd"><div class="eyebrow">effort</div><div class="title">${esc(e.title || e.slug)}</div><div class="sub">${esc(e.slug)} · ${its.length} run${its.length === 1 ? '' : 's'} · ${unlaunched.length} not launched</div></div>`;
    const rosterLegend = `<div class="legend-ico"><span class="eyebrow">state icons</span>${['human', 'flight', 'ready', 'waiting', 'approved', 'done', 'not-launched'].map((s) => `<span class="li">${ico(s)}${esc(STATE_WORDS[s])}</span>`).join('')}<span class="li">${ico('waiting', true)}needs you</span></div>`;
    const roster = `<ul class="roster">
<li class="rost brain" data-entry="brain" data-epoch="${epoch}" data-decisions="${brainDecisions === null ? 'unknown' : brainDecisions}"><span class="row"><span class="name">${ico('brain')}brain</span><span class="src">epoch ${epoch}</span></span>
<span class="rollup"><span class="h"><b>${laneCount('human')}</b> need you</span><span><b>${laneCount('flight')}</b> in flight</span><span><b>${laneCount('ready')}</b> ready</span><span><b>${laneCount('waiting') + laneCount('approved')}</b> waiting</span><span><b>${laneCount('done')}</b> done</span></span>
<span class="ea">${ledgerError ? 'ledger unreadable — the brain\'s own decisions cannot be counted' : `${brainDecisions} decided alone`} · ${its.filter((r) => r.status === 'blocked').length} blocked</span></li>
${cards.map((c) => rosterEntry(c, droppedIds.includes(c.id) ? 'dropped' : 'card')).join('\n')}
${its.filter((r) => !rosterIds.has(r.id)).map((r) => rosterEntry({ id: r.id }, 'run-only')).join('\n')}</ul>`;

    // The graph answers "why is this card waiting": one node per card, and blocking drawn as a
    // labelled edge — dependency, open question, file overlap. A node with no edge is not waiting.
    // A card with no run and no wave has an UNKNOWN reason, not no reason: `clear` would be this
    // page telling a reader nothing holds a card it never managed to ask about.
    const node = (c) => {
      const r = runs[c.id];
      const unknown = !r && !wave;
      const es = unknown ? [] : edgesFor(c, r, wave);
      const tail = unknown
        ? ` <span class="edge" data-edge="unknown">the fan could not be computed — why this card waits is unknown</span>`
        : es.length ? '' : ' <span class="clear">clear</span>';
      return `<li class="node" data-node="${esc(c.id)}" data-edges="${unknown ? 'unknown' : es.length}"><b>${esc(c.id)}</b>${es.map((g) => ` <span class="edge" data-edge="${esc(g.kind)}"${g.from ? ` data-from="${esc(g.from)}"` : ''}>${esc(g.kind === 'overlap' ? `file overlap · ${g.path} · ${g.from}` : g.kind === 'dependency' ? `dependency · ${g.text}` : g.text)}</span>`).join('')}${tail}</li>`;
    };

    // The same answer as a PICTURE. The design draws the fan as nodes in columns with labelled
    // wires, and the columns are waves. The ledger records no wave NUMBER for a card — planWave
    // computes one wave, the next one, and never keeps a history — so the columns here are the
    // DEPENDENCY DEPTH the fan dispatches in: depth 1 is every card that waits for nothing, and a
    // card sits one column right of the deepest card it declares in `after`. That is derivable and
    // true; a wave number would have been invented. A dependency cycle cannot be layered at all,
    // so `seen` stops the walk and those cards fall to depth 1 rather than hanging the renderer.
    const byCard = new Map(cards.map((c) => [c.id, c]));
    const depthOf = (() => {
      const memo = new Map();
      const walk = (id, seen) => {
        if (memo.has(id)) return memo.get(id);
        const c = byCard.get(id);
        if (!c || seen.has(id)) return 0;
        seen.add(id);
        const d = (c.after || []).filter((a) => byCard.has(a)).reduce((m, a) => Math.max(m, walk(a, seen) + 1), 0);
        seen.delete(id);
        memo.set(id, d);
        return d;
      };
      return (id) => walk(id, new Set());
    })();
    const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
    const dagSvg = () => {
      if (!cards.length) return '<div class="pendbox">This effort declares no cards, so there is no fan to draw.</div>';
      const NW = 232; const NH = 82; const CG = 56; const RG = 24; const TOP = 44; const PAD = 12;
      // A depth with twenty cards in it would draw one column a screen and a half tall, so a depth
      // WRAPS into as many columns as it needs at six rows each. The columns of one depth stay
      // adjacent and only the first carries the depth label, so the reading — left is earlier —
      // survives the wrap.
      const ROWS = 6;
      const byDepth = new Map();
      for (const c of cards) { const d = depthOf(c.id); if (!byDepth.has(d)) byDepth.set(d, []); byDepth.get(d).push(c); }
      const depths = [...byDepth.keys()].sort((a, b) => a - b);
      const columns = [];
      for (const d of depths) {
        const list = byDepth.get(d);
        for (let i = 0; i < list.length; i += ROWS) columns.push({ depth: d, first: i === 0, cards: list.slice(i, i + ROWS) });
      }
      const pos = new Map();
      columns.forEach((col, i) => col.cards.forEach((c, j) => pos.set(c.id, [PAD + i * (NW + CG), TOP + j * (NH + RG)])));
      const rows = Math.max(...columns.map((col) => col.cards.length));
      const W = PAD * 2 + columns.length * (NW + CG) - CG;
      const H = TOP + rows * (NH + RG) + 6;
      const right = (id) => [pos.get(id)[0] + NW, pos.get(id)[1] + NH / 2];
      const left = (id) => [pos.get(id)[0], pos.get(id)[1] + NH / 2];
      const wires = [];
      const wire = (a, b, cls, label) => {
        if (!pos.has(a) || !pos.has(b)) return;
        let d; let lx; let ly;
        const [ax, ay] = right(a); const [bx, by] = left(b);
        if (ax < bx) { const mx = (ax + bx) / 2; d = `M${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`; lx = mx; ly = (ay + by) / 2 - 7; }
        else { // same column or backwards: leave from the bottom, arrive at the top
          const [px, py] = pos.get(a); const [qx, qy] = pos.get(b);
          const sx = px + NW / 2; const sy = py + NH; const ex = qx + NW / 2;
          d = `M${sx} ${sy} C ${sx} ${sy + 22}, ${ex} ${qy - 22}, ${ex} ${qy}`; lx = (sx + ex) / 2; ly = (sy + qy) / 2;
        }
        const forward = ax < bx;
        ly += wires.length % 2 ? 0 : 11;
        wires.push(`<path class="wire ${esc(cls)}" d="${d}" marker-end="url(#ah-${esc(domId(e.slug))})"/>${label && forward ? `<text class="wlabel ${cls === 'hold' ? 'hold' : ''}" x="${lx}" y="${ly}" text-anchor="middle">${esc(clip(label, 26))}</text>` : ''}`);
      };
      for (const c of cards) {
        for (const a of (c.after || [])) {
          const dep = runs[a];
          wire(a, c.id, dep && dep.lane === 'done' ? 'done' : 'hold', dep && dep.lane === 'done' ? 'closed' : `waits for ${a}`);
        }
        for (const h of holdsFor(wave, c.id)) if (h.kind === 'overlap' && h.from !== c.id) wire(h.from, c.id, 'contend', `shares ${h.path}`);
      }
      const nodes = cards.map((c) => {
        const r = runs[c.id];
        const state = r ? r.lane : 'not-launched';
        const [x, y] = pos.get(c.id);
        const est = estimateOf(c, r, cfg);
        const act = r ? actualOf(r) : null;
        const mark = state === 'human' ? `<rect class="human-mark" x="${x + NW - 14}" y="${y - 8}" width="14" height="14" rx="2" transform="rotate(45 ${x + NW - 7} ${y - 1})"><title>waiting on you</title></rect>` : '';
        return `<a href="#${esc(detailId(c.id))}"><g class="node ${esc(state)}" data-svg-node="${esc(c.id)}"><title>${esc(c.id)} · ${esc(STATE_WORDS[state] || state)}</title><rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="6"/>
<text class="id" x="${x + 10}" y="${y + 16}">${esc(clip(c.id, 18))}</text><text class="st" x="${x + NW - 10}" y="${y + 16}" text-anchor="end">${esc(state === 'not-launched' ? 'not launched' : state)}</text>
<text class="nm" x="${x + 10}" y="${y + 37}">${esc(clip(c.title || c.id, 30))}</text><text class="tc" x="${x + 10}" y="${y + 55}">${esc(clip(stepWord(r), 30))}</text><text class="ea" x="${x + 10}" y="${y + 70}">est ${esc(est ? `${est.value} ${String(est.unit).replace(/_/g, ' ')}` : 'none')} · act ${esc(actualText(act))}</text></g></a>${mark}`;
      }).join('');
      const heads = columns.map((col, i) => `${col.first ? `<text class="wl" x="${PAD + i * (NW + CG) + NW / 2}" y="26" text-anchor="middle">depth ${col.depth + 1}</text>` : ''}${i < columns.length - 1 && columns[i + 1].first ? `<line class="wsep" x1="${PAD + i * (NW + CG) + NW + CG / 2}" y1="34" x2="${PAD + i * (NW + CG) + NW + CG / 2}" y2="${H - 6}"/>` : ''}`).join('');
      return `<svg class="dag" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Fan-out of ${esc(e.slug)}: ${esc(String(cards.length))} cards in ${esc(String(depths.length))} dependency depth${depths.length === 1 ? '' : 's'}. The list below this picture carries the same edges as text.">
<defs><marker id="ah-${esc(domId(e.slug))}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--ink3)"/></marker></defs>
${heads}${wires.join('')}${nodes}</svg>`;
    };

    // The swimlanes answer "how far along is it", each on its own cycle's ruler.
    const lane = (c) => {
      const r = runs[c.id];
      const ruler = rulerFor(processDir, c, r);
      const est = estimateOf(c, r, cfg);
      const act = r ? actualOf(r) : null;
      const estMs = estimateMs(est, hoursPerDay(cfg));
      const over = act && act.ms !== null && estMs !== null && act.ms > estMs;
      return `<div class="lane" data-lane="${esc(c.id)}" data-cycle="${esc(c.cycle || (r && r.st.cycle) || '')}" data-steps="${ruler.length}"><b>${ico(r ? r.lane : 'not-launched', Boolean(r && r.lane === 'human'))}<a href="#${esc(detailId(c.id))}">${esc(clip(c.id, 20))}</a><span class="sm">${esc(c.cycle || (r && r.st.cycle) || 'no cycle')} · ${ruler.length} step${ruler.length === 1 ? '' : 's'}</span></b><span class="eac"><span class="${over ? 'over' : ''}">${esc(actualText(act))}</span> / ${esc(estMs === null ? '?' : timing.humanMs(estMs))}</span><div class="cells">${ruler.map((s) => `<i class="cell" data-step="${esc(s.id)}" data-state="${esc(s.state)}" title="${esc(s.id)} · ${esc(s.state)}"></i>`).join('') || '<i class="cell" data-step="" data-state="pending" title="this card\'s cycle could not be read, so it has no ruler"></i>'}</div></div>`;
    };

    // The needs-a-human strip: what the board cannot decide for itself, each with the action that
    // settles it. A merge conflict carries Unblock, and WHICH repair it names comes from the card's
    // own cycle — see conflictRepair above: a PR cycle merges origin/main on `resync`, a commit
    // cycle rebases with `plt card rebase` and accepts the re-approval it costs, because approvals
    // are tree-pinned. A stale reference carries force-index, which is human-triggered by rule:
    // the brain never reindexes another KB.
    //
    // Each item is drawn as the design draws it: the KIND on the left, the title and the context in
    // the middle, and on the right SINCE WHEN — taken from the ledger's own timestamp, never from
    // the clock. An item the ledger carries no timestamp for says that instead of borrowing one.
    const needItem = (attrs, kind, title, ctx, since) => `<li class="need" ${attrs}><span class="kind">${esc(kind)}</span><div class="nbody"><div class="ntitle">${title}</div>${ctx ? `<div class="nctx">${ctx}</div>` : ''}</div><span class="since">${since ? esc(since) : '<span class="muted">no timestamp recorded</span>'}</span></li>`;
    const needs = [];
    for (const r of its) {
      if (r.lane === 'human') {
        needs.push(needItem(`data-need="gate" data-card="${esc(r.id)}"`, '◇ gate',
          `${cardAnchor(L, r.id)} — ${esc(r.inputs.title || r.id)}`,
          `<code>${esc(r.next)}</code>`, r.last ? `since ${stamp(r.last.ts, 5)}` : null));
      }
      // The LATEST merge attempt, not any of them. `some()` over every merge event meant a conflict
      // that was resolved and landed a week ago still offered a rebase — of a branch that is merged.
      // A landed PR settles it outright, whichever way the last attempt went.
      const lastMerge = r.events.filter((v) => v.kind === 'time' && v.step === 'merge' && v.outcome).pop();
      const landed = (r.facts && r.facts.state === 'MERGED')
        || r.events.some((v) => v.kind === 'gh' && v.name === 'merged' && v.result === 'pass');
      const dirty = !landed && r.lane !== 'done'
        && ((r.facts && r.facts.mergeStateStatus === 'DIRTY') || (lastMerge && lastMerge.outcome === 'conflict'));
      if (dirty) {
        const rep = conflictRepair(r.st, e.slug, r.id);
        needs.push(needItem(`data-need="conflict" data-card="${esc(r.id)}" data-repair="${esc(rep.kind)}"`, '⎇ conflict',
          `${cardAnchor(L, r.id)} — main moved under ${esc(rep.subject)}.`,
          `<b>Unblock</b> (${esc(rep.why)}): <code>${esc(rep.command)}</code>`,
          (r.facts && r.facts.at) ? `since ${stamp(r.facts.at, 5)}` : (lastMerge ? `since ${stamp(lastMerge.ts, 5)}` : null)));
      }
    }
    for (const c of cards) {
      const holds = holdsFor(wave, c.id);
      // An Unblock clears CONTENTION ONLY. A card held by a dependency as well would not move
      // if someone took it, so offering the choice there asks for a decision that changes nothing —
      // and reads as though the work were ready when its inputs do not exist yet.
      if (holds.some((h) => h.kind === 'dependency')) continue;
      for (const h of holds) {
        if (h.kind !== 'overlap') continue;
        // Contention HOLDS the card and asks. The hold and the overlap are facts, and the
        // reader needs them. The two ACTIONS (unblock, hold) are not implemented for cards yet —
        // `plt fan --unblock` clears plan task numbers, not effort cards, and `--only` refuses an
        // excluded card — so this states the choice and says plainly that nothing takes it. A
        // button that does nothing is worse than no button; a fact withheld is worse than both.
        needs.push(needItem(`data-need="contention" data-action="none" data-card="${esc(c.id)}" data-from="${esc(h.from)}"`, '◇ held',
          `${cardAnchor(L, c.id)} is <b>held</b>: it shares <code>${esc(h.path)}</code> with ${cardAnchor(L, h.from)}.`,
          `Running the two in parallel buys a rebase; holding lands it in the next wave once ${esc(h.from)} closes. <span class="muted">No command takes this decision yet — <code>plt fan --unblock</code> clears plan task numbers, not effort cards.</span>`,
          null));
      }
    }
    // The fan itself failing is a needs-a-human item: until the effort file is readable, every
    // "why is this waiting" on the page is a blank, and the graph says so rather than saying clear.
    if (waveError) {
      needs.push(needItem(`data-need="fan-unavailable" data-effort="${esc(e.slug)}"`, '⚠ fan',
        `the wave for <b>${esc(e.slug)}</b> could not be computed, so no card's hold is known:`,
        `<code>${esc(waveError)}</code>`, null));
    }
    if (ledgerError) {
      needs.push(needItem(`data-need="ledger-unreadable" data-effort="${esc(e.slug)}"`, '⚠ ledger',
        `the effort ledger for <b>${esc(e.slug)}</b> could not be read, so the decision log and the brain's count below are empty rather than zero:`,
        `<code>${esc(ledgerError)}</code>`, null));
    }
    for (const ref of staleReferences(e, cfg, newest)) {
      const said = ref.why === 'stale' ? `was indexed ${stamp(ref.last_indexed)} — past ${String((cfg && cfg.references && cfg.references.stale_after) || '14d')}`
        : ref.why === 'never-indexed' ? 'records no last-indexed date, so it is as stale as a reference can be'
          : 'cannot be checked: this board carries no event to measure staleness against';
      needs.push(needItem(`data-need="stale-reference" data-ref="${esc(ref.id)}" data-why="${esc(ref.why)}"`, '◆ reference',
        `reference <b>${esc(ref.id)}</b> ${esc(said)}.`,
        `<b>force-index</b>${ref.reindex ? `: <code>${esc(ref.reindex)}</code>` : ' that KB before trusting a plan written against it'}`,
        ref.last_indexed ? `indexed ${stamp(ref.last_indexed)}` : 'never indexed'));
    }
    // The strip itself, in the design's human-soft band at the top of the main column: a count, a
    // heading, and the items. An EMPTY strip is still drawn — a board that shows nothing when
    // nothing is waiting leaves the reader unsure whether it looked.
    const strip = `<section class="needs-strip" aria-label="Needs a human now"><div class="nh"><span class="n">${needs.length}</span><h3>Needs a human now</h3><span class="meta">from the ledger · act here or open the card</span></div>${needs.length ? `<ul class="needs">${needs.join('')}</ul>` : '<div class="nempty">Nothing on this effort is waiting on a person. Items appear here when a gate opens, a question is asked, main moves under a card, or a reference goes stale.</div>'}</section>`;

    // The decision log — the design's "The brain decided:" panel. Keyed by `who`: `fan` is the
    // computation deciding, `brain` is the orchestrator deciding alone, `gate` is a person. Three
    // authorities share one column, and each keeps its own pill colour.
    const decisions = ledger.filter((v) => ['decision', 'escalation'].includes(v.kind));
    const decRow = (v) => `<div class="decision" data-who="${esc(v.who)}" data-kind="${esc(v.kind)}"><span class="t">${esc(stamp(v.ts, 5))}</span><div class="w"><b>${esc(v.what || v.kind)}</b> <span class="pill who-${esc(v.who)}">${esc(v.who)}</span>${v.text ? `<div class="why">${esc(v.text)}</div>` : ''}${v.gate_epoch === undefined ? '' : `<div class="why mono">epoch ${esc(v.gate_epoch)}</div>`}</div></div>`;
    const decBody = ledgerError
      ? `<p class="muted" data-log="unreadable">The effort ledger could not be read. What is missing below is not a count of zero decisions, it is an absence of data: <code>${esc(ledgerError)}</code></p>`
      : decisions.length ? decisions.map(decRow).join('')
        : '<p class="muted">The ledger carries no decision yet. This panel fills as the fan holds a card, the brain answers one, or a gate escalates.</p>';
    // `data-log` names WHICH log a decision row sits in. The same ledger line legitimately appears
    // twice on this page — once here, and once under every card it names — so a reader (and a
    // test) has to be able to tell the whole log from one card's slice of it.
    const decPanel = `<div class="panel"><div class="ph"><h3>The brain decided:</h3><span class="meta">oldest first · fan · brain · gate</span></div><div class="pb" data-log="ledger">${decBody}</div></div>`;

    // Arc — done, in flight, needs you, waiting — and then the two questions a reader asks of it:
    // what is next on them, and what opens the next wave. Both are answered from the ledger or not
    // at all; the design's "effort done when" line has no source here and is not invented.
    const arcRow = (label, list) => `<div class="arcrow"><span class="eyebrow">${esc(label)}</span><div class="fanrow">${list.length ? list.map((c) => `<a class="chip ${esc(runs[c.id] ? runs[c.id].lane : 'not-launched')}" href="#${esc(detailId(c.id))}">${esc(clip(c.id, 26))}</a>`).join('') : '<span class="muted">none</span>'}</div></div>`;
    const inLane = (l) => cards.filter((c) => runs[c.id] && runs[c.id].lane === l);
    const notLaunched = cards.filter((c) => !runs[c.id]);
    const firstNeed = its.find((r) => r.lane === 'human');
    const arcPanel = `<div class="panel"><div class="ph"><h3>Arc</h3><span class="meta">done · in flight · next</span></div><div class="pb">
${arcRow('done', inLane('done'))}${arcRow('in flight', inLane('flight'))}${arcRow('needs you', inLane('human'))}${arcRow('waiting or ready', [...inLane('waiting'), ...inLane('approved'), ...inLane('ready')])}${arcRow('not launched', notLaunched)}
<dl class="kv"><dt>next on you</dt><dd>${firstNeed ? `${cardAnchor(L, firstNeed.id)} — <code>${esc(firstNeed.next)}</code>` : 'nothing'}</dd>
<dt>in the wave</dt><dd>${wave ? (wave.wave.length ? wave.wave.map((c) => cardAnchor(L, c.id)).join(' · ') : 'no card is dispatchable right now') : `<span class="muted">the wave could not be computed: ${esc(waveError || 'unknown')}</span>`}</dd>
<dt>held</dt><dd>${wave ? (wave.excluded.length ? wave.excluded.map((x) => `${esc(x.card)} <span class="muted">(${esc(x.why)})</span>`).join('<br>') : 'nothing') : '<span class="muted">unknown</span>'}</dd></dl></div></div>`;

    // Estimate vs actual — and, everywhere it can occur, the third answer. A card whose actual the
    // ledger cannot evidence does not get a verdict; it says so, and it is left OUT of the effort
    // total rather than folded in as zero. Summing every card's estimate against only the actuals
    // that exist made an effort read "within budget" most confidently when the least work had
    // happened: nine unlaunched cards contributing a full estimate and no elapsed at all.
    const hpd = hoursPerDay(cfg);
    const rollRow = (c) => {
      const r = runs[c.id];
      const est = estimateOf(c, r, cfg);
      const estMs = estimateMs(est, hpd);
      const act = r ? actualOf(r) : null;
      const over = overrunOf(act, estMs);
      const counted = over !== 'unknown' || (estMs !== null && act && act.ms !== null && !act.open);
      const estCell = est
        ? (estMs === null ? `<span class="muted">unit <code>${esc(est.unit)}</code> not understood</span>` : esc(timing.humanMs(estMs)))
        : '<span class="muted">no estimate</span>';
      const actCell = !r ? '<span class="muted">no run</span>'
        : act.ms === null ? `<span class="muted">no data — ${esc(act.why)}</span>`
          : `${act.open ? '≥ ' : ''}${esc(timing.humanMs(act.ms))}${act.open ? ' <span class="muted">(open)</span>' : ''}`;
      return { id: c.id, estMs, act, over, counted, est,
        cells: `<td>${cardAnchor(L, c.id)}</td><td class="num">${est ? `${esc(est.value)} ${esc(String(est.unit).replace(/_/g, ' '))}` : '—'}</td><td class="num">${estCell}</td><td class="num">${actCell}</td><td>${over === 'true' ? '<span class="pill bad">over</span>' : over === 'false' ? '<span class="pill ok">within</span>' : '<span class="pill wait">unknown</span>'}</td>` };
    };
    const rolls = cards.map(rollRow);
    // Only the rows that carry both halves. `counted` is the honest denominator, and the row says
    // how many cards it had to leave out — a total over a subset that does not admit it is a lie
    // with a number attached.
    const counted = rolls.filter((v) => v.counted && v.estMs !== null && v.act && v.act.ms !== null);
    const uncounted = rolls.length - counted.length;
    const sumEst = counted.reduce((a, v) => a + v.estMs, 0);
    const sumAct = counted.reduce((a, v) => a + v.act.ms, 0);
    const totalVerdict = counted.length === 0 ? 'unknown' : uncounted > 0 ? 'partial' : String(sumAct > sumEst);
    // The design's bar: a dashed outline for the estimate, a solid fill for the actual, both to the
    // same scale. The scale is the largest number ON THE PAGE, so the bars compare with each other;
    // a row missing either half draws NO bar and says which half is missing — a bar drawn from one
    // number is a picture of a comparison that was never made.
    const maxV = Math.max(0, ...rolls.map((v) => Math.max(v.estMs || 0, (v.act && v.act.ms) || 0)));
    const pct = (v) => `${maxV > 0 ? ((v / maxV) * 100).toFixed(1) : 0}%`;
    const barCell = (v) => {
      if (v.estMs === null && !(v.act && v.act.ms !== null)) return '<td><span class="muted">no estimate and no actual</span></td>';
      if (v.estMs === null) return '<td><span class="muted">no estimate to draw against</span></td>';
      if (!v.act || v.act.ms === null) return `<td><div class="vb" title="estimate ${esc(timing.humanMs(v.estMs))} · no actual measured"><span class="e" style="width:${pct(v.estMs)}"></span></div></td>`;
      const cls = v.act.ms > v.estMs ? 'over' : v.act.open ? 'open' : '';
      return `<td><div class="vb" title="estimate ${esc(timing.humanMs(v.estMs))} (dashed) · actual ${esc(v.act.open ? '≥ ' : '')}${esc(timing.humanMs(v.act.ms))} (fill)"><span class="e" style="width:${pct(v.estMs)}"></span><span class="a ${cls}" style="width:${pct(v.act.ms)}"></span></div></td>`;
    };
    const kpi = (value, label, cls) => `<div><div class="v ${cls || ''}">${value}</div><div class="l">${label}</div></div>`;
    const variance = counted.length && sumEst > 0 ? Math.round(((sumAct - sumEst) / sumEst) * 100) : null;
    const kpis = `<div class="kpis">${kpi(counted.length ? esc(timing.humanMs(sumEst)) : '<span class="muted">no data</span>', `estimated, over the ${counted.length} card${counted.length === 1 ? '' : 's'} that can be measured`)}
${kpi(counted.length ? esc(timing.humanMs(sumAct)) : '<span class="muted">no data</span>', 'actual elapsed on those cards')}
${kpi(variance === null ? '<span class="muted">unknown</span>' : `${variance > 0 ? '+' : ''}${variance}%`, 'variance on the measured cards', variance === null ? '' : variance > 0 ? 'over' : 'under')}
${kpi(esc(String(uncounted)), `card${uncounted === 1 ? '' : 's'} with no measurable actual, left out of both totals`)}</div>`;
    const rollPanel = `<div class="panel"><div class="ph"><h3>Estimate vs actual</h3><span class="meta">estimates convert at ${hpd}h/day · actual is calendar elapsed</span></div>
${kpis}
<div class="pb tw"><table><tr><th>Card</th><th>Estimate</th><th class="num">Estimate (at ${hpd}h/day)</th><th class="num">Actual elapsed</th><th></th><th>est (dashed) vs actual</th></tr>${rolls.map((v) => `<tr class="roll" data-roll="${esc(v.id)}" data-overrun="${v.over}" data-counted="${v.counted}">${v.cells}${barCell(v)}</tr>`).join('')}<tr class="rolltotal" data-overrun="${totalVerdict}" data-counted="${counted.length}" data-uncounted="${uncounted}"><td><b>effort</b> <span class="muted">${counted.length} of ${rolls.length} card${rolls.length === 1 ? '' : 's'} measured</span></td><td class="num">—</td><td class="num">${counted.length ? esc(timing.humanMs(sumEst)) : '<span class="muted">no data</span>'}</td><td class="num">${counted.length ? esc(timing.humanMs(sumAct)) : '<span class="muted">no data</span>'}</td><td>${totalVerdict === 'true' ? '<span class="pill bad">over</span>' : totalVerdict === 'false' ? '<span class="pill ok">within</span>' : `<span class="pill wait">${uncounted && counted.length ? 'partial' : 'unknown'}</span>`}</td><td></td></tr></table></div>
<div class="pb"><p class="muted">Actual is CALENDAR elapsed while a step was open, projected from the ledger’s <code>time</code> events and measured to each run’s last event — never to the clock, so this page renders the same twice. What that does NOT measure: time a step has been open since that last event counts as nothing, so an open step is a LOWER BOUND, marked <code>≥</code>; a run with no <code>time</code> events has no actual at all and is left out of the effort total rather than counted as zero. It is elapsed, not effort.</p></div></div>`;

    // ---- the artifact viewer, and the per-card detail -----------------------------------------
    // Both are `:target` sections: the page is written to disk and opened as a file, so the drawer
    // and the detail open from the URL fragment and need no script at all. At rest — no fragment —
    // the drawer is closed and the overview is the page, which is the state the design shows.
    // WHAT the drawer can show is the honest limit: the ledger records an artifact's NAME, its
    // step, when it was recorded and its URL. It does not hold the document, so the drawer gives
    // those four facts and a link, and says as much rather than framing an empty box.
    const artEvents = (r) => {
      const out = new Map();
      for (const v of r.events) if (v.kind === 'artifact' && v.ref && isUrl(v.ref)) out.set(v.name, v);
      return out;
    };
    const drawers = its.map((r) => {
      const evs = artEvents(r);
      return PAGE_LINKS.filter(([k]) => evs.has(k)).map(([k, label]) => {
        const v = evs.get(k);
        return `<aside class="drawer" id="${esc(artId(r.id, k))}" aria-label="Artifact ${esc(k)} of ${esc(r.id)}">
<a class="scrim" href="#${esc(detailId(r.id))}" aria-label="Close the artifact viewer"></a>
<div class="dw-h"><div class="top"><span class="eyebrow">${esc(r.id)} · ${esc(label)}</span><a class="btn" href="#${esc(detailId(r.id))}">Close ✕</a></div><h3>${esc(k)}</h3><div class="pathline"><span>recorded ${esc(stamp(v.ts, 5))}</span><span>step ${esc(v.step || 'unrecorded')}</span></div></div>
<div class="dw-b"><div class="pendbox">The ledger records this artifact’s name, the step that produced it, when the receipt was taken and its address. It does not hold the document, so the page cannot show the text here — the link below is the artifact itself.</div></div>
<div class="dw-f"><a class="btn acc" href="${esc(v.ref)}">Open ${esc(label)} ↗</a><span class="mono">${esc(v.ref)}</span></div></aside>`;
      }).join('');
    }).join('');

    const stepRuler = (c, r) => {
      const ruler = rulerFor(processDir, c, r);
      if (!ruler.length) return `<p class="muted">This card’s cycle (<code>${esc(c.cycle || 'none declared')}</code>) could not be read, so it has no ruler to draw.</p>`;
      return `<div class="steps">${ruler.map((st, i) => `<div class="step" data-state="${esc(st.state)}">${i > 0 ? (st.gate ? '<span class="gate" title="human gate"></span>' : '<span class="g">→</span>') : ''}<span class="b">${esc(st.id)}</span></div>`).join('')}</div>`;
    };
    const detailBlock = (c, source) => {
      const r = runs[c.id];
      const state = r ? r.lane : 'not-launched';
      const est = estimateOf(c, r, cfg);
      const estMs = estimateMs(est, hpd);
      const act = r ? actualOf(r) : null;
      const over = Boolean(act && act.ms !== null && estMs !== null && act.ms > estMs);
      const width = act && act.ms !== null && estMs ? `${Math.min(act.ms / estMs, 1) * 100}%` : '0%';
      const meter = `<div class="meter"><div class="mt">est <b>${esc(estMs === null ? (est ? `${est.value} ${est.unit}` : 'none') : timing.humanMs(estMs))}</b> · act <b class="${over ? 'over' : ''}">${esc(actualText(act))}</b></div><div class="bar"><i class="${over ? 'over' : ''}" style="width:${width}"></i></div></div>`;
      const holds = holdsFor(wave, c.id);
      const why = r ? `<code>${esc(r.next)}</code>`
        : holds.length ? esc(holds.map((h) => h.text).join('; '))
          : wave ? 'Nothing holds this card: it is dispatchable in the current wave.'
            : `<span class="muted">The wave could not be computed, so why this card waits is unknown: ${esc(waveError || '')}</span>`;
      const evs = r ? artEvents(r) : new Map();
      const artRows = r
        ? (PAGE_LINKS.filter(([k]) => evs.has(k)).map(([k, label]) => {
          const v = evs.get(k);
          return `<div class="artrow"><a class="an" href="#${esc(artId(r.id, k))}">${esc(k)}</a><span class="at">${esc(stamp(v.ts, 5))}</span></div>`;
        }).join('') || '<div class="artrow pend"><span class="an">no artifact recorded</span><span class="at">—</span></div>')
        : '<div class="artrow pend"><span class="an">not launched, so no artifact</span><span class="at">—</span></div>';
      const facts = r
        ? `<dl class="kv"><dt>steps done</dt><dd>${r.done} of ${r.total}</dd><dt>PR</dt><dd>${prCell(r)}</dd><dt>counters</dt><dd>${r.gates} gate${r.gates === 1 ? '' : 's'} · ${r.reprompts} re-prompt${r.reprompts === 1 ? '' : 's'} · ${r.extrapolations} extrapolation${r.extrapolations === 1 ? '' : 's'}${r.outOfBand ? ` · ${r.outOfBand} out of band` : ''}</dd><dt>last event</dt><dd class="mono">${r.last ? esc(stamp(r.last.ts, 5)) : 'none'}</dd><dt>status page</dt><dd>${r.artifacts['run-' + r.id] ? `<a href="${esc(r.artifacts['run-' + r.id])}">run page</a>` : '<span class="muted">not published</span>'}</dd></dl>`
        : '<p class="muted">This card has no run, so the ledger carries no facts about it: no steps, no PR, no elapsed. It is a line in the effort file and nothing more yet.</p>';
      const mine = ledgerError ? [] : decisions.filter((v) => [v.what, v.text, v.card].some((x) => String(x || '').includes(c.id)));
      return `<section class="detail" id="${esc(detailId(c.id))}" data-detail="${esc(c.id)}" data-state="${esc(state)}">
<a class="back" href="#${esc(domId('effort-' + e.slug))}">← back to the effort</a>
<div class="dhead"><div><div class="eyebrow">${esc(c.id)} · ${esc(source)} · depth ${depthOf(c.id) + 1} · ${esc(c.cycle || (r && r.st.cycle) || 'no cycle')}</div><h2>${esc(c.title || (r && r.inputs.title) || c.id)}</h2>
<div class="path">${cardAnchor(L, c.id)}${(c.touches || []).map((t) => `<span>touches ${esc(t)}</span>`).join('')}${(c.after || []).length ? `<span>after ${esc((c.after || []).join(', '))}</span>` : '<span>no declared dependency</span>'}</div></div>
<div class="right">${ico(state, state === 'human')} <span class="pill ${esc(pill(state) || 'wait')}">${esc(state === 'not-launched' ? 'not launched' : state)}</span>${meter}</div></div>
<div class="panel"><div class="ph"><h3>Cycle</h3><span class="meta">◇ = human gate</span></div><div class="pb">${stepRuler(c, r)}<p class="muted" style="margin:10px 0 0">${why}</p></div></div>
<div class="two">
<div class="panel"><div class="ph"><h3>Artifacts</h3><span class="meta">click a name to open its viewer</span></div><div class="pb artlist">${artRows}</div></div>
<div class="panel"><div class="ph"><h3>Run facts</h3></div><div class="pb">${facts}</div></div>
</div>
<div class="panel"><div class="ph"><h3>Decisions naming ${esc(c.id)}</h3></div><div class="pb" data-log="card">${ledgerError ? `<p class="muted">The ledger could not be read: <code>${esc(ledgerError)}</code></p>` : mine.length ? mine.map(decRow).join('') : '<p class="muted">No decision in the ledger names this card.</p>'}</div></div>
</section>`;
    };
    const details = cards.map((c) => detailBlock(c, droppedIds.includes(c.id) ? 'dropped' : 'card')).join('')
      + its.filter((r) => !rosterIds.has(r.id)).map((r) => detailBlock({ id: r.id, touches: [], after: [] }, 'run-only')).join('');

    // The wave bands over the swimlanes. The ledger holds no wave HISTORY — planWave computes the
    // current one — so the bands are what it can evidence: closed, dispatchable now, held, and
    // never launched. Numbered waves would have been a fiction.
    // The line under the bands names the cards the bands only count, and carries planWave's own
    // sentence for each exclusion — the reason a card is held, in the fan's words rather than a
    // second opinion.
    const waveLine = (w) => {
      if (!w) return `<p class="muted"><b>Wave:</b> the fan could not be computed: <code>${esc(waveError || 'unknown')}</code></p>`;
      return `<p class="muted"><b>Wave:</b> ${w.wave.length ? w.wave.map((c) => cardAnchor(L, c.id)).join(' ') : 'none'}${w.excluded.length ? ` · excluded: ${w.excluded.map((x) => `${esc(x.card)} (${esc(x.why)})`).join(' · ')}` : ''}${w.running.length ? ` · running: ${w.running.map(esc).join(' ')}` : ''}</p>`;
    };
    const bands = `<div class="wavebands"><span class="past">closed · ${its.filter((r) => r.lane === 'done').length}</span><span class="cur">in flight · ${its.filter((r) => r.lane === 'flight').length}</span><span>${wave ? `dispatchable now · ${wave.wave.length}` : 'dispatchable now · unknown'}</span><span class="held">${wave ? `held · ${wave.excluded.length}` : 'held · unknown'}</span><span>not launched · ${unlaunched.length}</span></div>`;

    const tab = `tab-${domId(e.slug)}`;
    const meta = `${its.filter((r) => r.lane === 'human').length} on you · ${its.filter((r) => r.lane === 'flight').length} in flight · ${its.filter((r) => r.lane === 'done').length} done · ${unlaunched.length} not launched`;
    const picture = `<div class="panel views">
<input class="tabin" type="radio" name="${esc(tab)}" id="${esc(tab)}-graph" checked>
<input class="tabin" type="radio" name="${esc(tab)}" id="${esc(tab)}-swim">
<div class="ph"><div class="tabs"><label for="${esc(tab)}-graph">Fan-out graph</label><label for="${esc(tab)}-swim">Cycle swimlanes</label></div><span class="meta">columns = dependency depth · edges = why a card waits</span></div>
<div class="view" data-view="graph"><div class="dagwrap">${dagSvg()}</div>
<ul class="graph">${cards.map(node).join('')}</ul>
<div class="legend"><span><i class="d"></i>dependency closed</span><span><i class="h"></i>waiting on a dependency or a question</span><span><i class="c"></i>held: file overlap with another open card</span><span><span class="dm"></span>waiting on you</span></div></div>
<div class="view" data-view="swimlanes">${bands}<div class="lanes">${cards.map(lane).join('')}</div>
<div class="pb">${waveLine(wave)}</div>
<div class="legend"><span>one row per card, ruled by that card’s OWN cycle — the rows are not comparable step for step</span></div></div>
</div>`;
    const runsTable = (() => {
      // Every run as a table, under a fold: the roster, the picture and the detail views carry what
      // a reader needs, and this is the same facts in one grid for scanning. Nothing lives ONLY
      // here, so folding it hides nothing.
      const sorted = its.slice().sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane));
      if (!sorted.length) return '';
      const table = (rows) => `<div class="tw"><table><tr><th>Run</th><th>Run status</th><th>Step</th><th>Done</th><th>PR</th><th>Next</th><th>Pages</th><th>gates·re-prompts·extrap.</th><th>Last</th></tr>${rows.map(runRow).join('')}</table></div>`;
      const tally = (rows) => { const t = {}; for (const r of rows) t[r.status] = (t[r.status] || 0) + 1; return Object.entries(t).map(([k, v]) => `${v} ${k}`).join(' · '); };
      return `<div class="panel"><details class="doneblock"><summary>${sorted.length} run${sorted.length === 1 ? '' : 's'} as a table — ${esc(tally(sorted))}</summary>${table(sorted)}</details></div>`;
    })();
    return `<section class="effort" id="${esc(domId('effort-' + e.slug))}">
<div class="shell">
<aside class="left">${rosterHead}${roster}${rosterLegend}</aside>
<div class="main">
<div class="topbar"><h2>${esc(e.title || e.slug)}${e.epic && e.epic !== 'none' ? ` <span class="muted">· ${cardAnchor(L, e.epic)}</span>` : ''}</h2><span class="meta">${esc(meta)}</span></div>
${strip}
<div class="body">
${details}
<div class="overview">
${picture}
<div class="two">${decPanel}${arcPanel}</div>
${rollPanel}
${unlaunched.length ? `<p class="muted">Not launched: ${unlaunched.map((c) => cardAnchor(L, c)).join(' · ')}</p>` : ''}
${runsTable}
${open.length ? `<p class="muted"><b>Decisions open:</b> ${open.map((d) => `${esc(d.id)} — ${esc(d.question)}${d.status === 'recorded-wrong' ? ' <span class="pill bad">recorded wrong</span>' : ''}`).join('<br>')}</p>` : ''}
${e.links ? `<p class="muted">${Object.entries(e.links).map(([k, v]) => effortLink(k, v)).join(' · ')}</p>` : ''}
</div>
</div>
</div>
</div>
${drawers}
</section>`;
  };
  const all = Object.values(runs);
  const human = all.filter((r) => r.lane === 'human');
  const newest = all.map((r) => r.last && r.last.ts).filter(Boolean).sort().pop();
  const org = cfg.org ? String(cfg.org).charAt(0).toUpperCase() + String(cfg.org).slice(1) + ' ' : '';
  const title = `${org}Effort Index`;
  return `<meta charset="utf-8">
<title>${esc(title)}</title>
${INDEX_FONTS}
<style>
${INDEX_TOKENS}
${INDEX_CSS}
</style>
<div class="frame">
<header class="masthead">
<div>
<div class="eyebrow">the spine · effort index · ${efforts.length} effort${efforts.length === 1 ? '' : 's'} · ${ids.length} run${ids.length === 1 ? '' : 's'} · state as of ${newest ? esc(stamp(newest)) + 'Z' : 'no events'}</div>
<h1>${esc(title)}</h1>
<p>One row per card, the fan as a picture, and every gate that is waiting on a person. Rendered from the ledgers alone — nothing here is polled live, and nothing is measured against the clock.</p>
</div>
</header>
${human.length ? `<div class="human"><b>Needs you (${human.length}):</b> ${human.map((r) => `${runPage(r) ? `<a href="${esc(runPage(r))}">${esc(r.id)}</a>` : esc(r.id)} — <code>${esc(r.next)}</code>`).join('<br>')}</div>` : `<div class="calm"><b>Nothing waiting on you.</b> ${all.filter((r) => r.lane === 'flight').map((r) => `${esc(r.id)} is at ${esc(r.cur)}`).join(' · ') || 'No runs in flight.'}</div>`}
${efforts.length ? efforts.map(effortBlock).join('') : '<div class="panel"><div class="pb">This process declares no effort yet. <code>process/efforts/*.yaml</code> is empty, so there is no roster, no fan and no roll-up to draw.</div></div>'}
<p class="foot">Rendered by <code>plt render index</code> from <code>process/efforts/*.yaml</code>, <code>process/runs/*/state.yaml</code>, <code>events.jsonl</code> and the facts snapshot <code>plt facts</code> keeps on each run. Counters: g = human gate events, r = re-prompts recorded, x = extrapolations, o = receipts recorded out of band.${L.board ? ` The curated <a href="${esc(L.board)}">board</a> remains the narrative.` : ''}</p>
</div>
`;
}

// ---- the run page ----
function overlapCell(processDir, runId, st) {
  if (st.status === 'closed') return 'n/a (closed)';
  try {
    const pin = st.repo_dir && fs.existsSync(st.repo_dir) ? spine.computePin(st.repo_dir) : null;
    const oc = effort.overlapCheck(processDir, runId, pin && !pin.refused ? { pin } : {});
    const parts = oc.shared.length ? oc.shared.map((s) => `${s.files.length} file${s.files.length === 1 ? '' : 's'} shared with ${s.run}`) : ['clear'];
    if (!oc.baseFresh) parts.push('base stale');
    return parts.join(' · ');
  } catch (e) { return 'n/a'; }
}

function renderRun(processDir, runId, cfg) {
  cfg = cfg || spine.loadConfig(processDir, runId);
  const L = links(cfg);
  const st = spine.readState(processDir, runId);
  if (!st) throw new Error(`no run ${runId} under ${processDir}/runs`);
  const inputs = spine.readInputs(processDir, runId);
  const events = spine.readEvents(processDir, runId);
  const handoffFile = path.join(processDir, 'runs', runId, 'HANDOFF.md');
  const handoff = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, 'utf8') : '';
  const pr = prOf(events, inputs, L);
  const f = factsOf(st, events);
  const overlap = overlapCell(processDir, runId, st);
  const stepOrder = Object.keys(st.steps || {});
  const cur = currentStep(st);
  const me = firstHuman(cfg);
  const ownerReady = cur && st.steps[cur].status === 'ready' && (st.steps[cur].receipts_required || []).some((r) => r.kind === 'gate');
  const nextCmd = (() => {
    if (st.status === 'closed') return `closed ${stamp(st.closed)}`;
    if (cur && st.steps[cur].status === 'blocked') return `plt answer ${runId} ${cur} --text <answer> --by human:${me}  — ${spine.openQuestion(events, cur) || 'the question'}`;
    if (cur && st.steps[cur].status === 'in_review') return `plt gate approve ${runId} ${cur} --by human:${me}`;
    if (cur && st.steps[cur].status === 'in_progress') return `plt step finish ${cur} --run ${runId} --outcome <outcome>`;
    if (cur && spine.betweenRounds(st, events, cur)) return `nothing for you — waiting on the next ${cur}`;
    if (cur && st.steps[cur].status === 'ready') return ownerReady ? `plt gate approve ${runId} ${cur} --by human:${me}  (review the page first)` : `plt step start ${cur} --run ${runId}`;
    return stepOrder.every((s) => st.steps[s].status === 'done') ? 'run complete' : '—';
  })();
  const humanNeeded = Boolean(cur && (st.steps[cur].status === 'in_review' || ownerReady));
  const gates = events.filter((e) => e.kind === 'gate');
  const adversarial = events.filter((e) => e.kind === 'agent');
  const extrapolations = events.filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.scope !== 'none');
  const reprompts = events.filter((e) => e.kind === 'reprompt');
  const outOfBand = events.filter((e) => e.out_of_band === true).length;
  const lastEvent = events[events.length - 1];
  const artifactList = (name) => { const seen = new Set(); return events.filter((e) => e.kind === 'artifact' && e.name === name && e.ref && isUrl(e.ref)).filter((e) => !seen.has(e.ref) && seen.add(e.ref)); };
  const latest = (name) => artifactList(name).pop();
  const rounds = (name, label) => { const u = artifactList(name); return u.length ? u.map((e, i) => `<a href="${esc(e.ref)}">${label} ${i + 1}</a> · ${esc(stamp(e.ts, 5))}`).join(' · ') : 'none'; };
  const stepRow = (id) => {
    const s = st.steps[id]; const reqs = s.receipts_required || [];
    // A receipt recorded out of band is shown apart, never as seen: the spine did not collect it.
    const seen = reqs.filter((r) => events.some((e) => e.step === id && e.kind === r.kind && e.name === r.name && !e.out_of_band)).length;
    const oob = events.filter((e) => e.step === id && e.out_of_band === true).length;
    const cls = s.status === 'done' ? 'ok' : s.status === 'in_review' ? 'human' : s.status === 'in_progress' ? 'wip' : s.status === 'blocked' ? 'bad' : 'mute';
    return `<tr class="${id === cur ? 'cur' : ''}"><td>${esc(id)}</td><td><span class="pill ${cls}">${esc(s.status)}</span></td><td class="num">${seen}/${reqs.length}${oob ? ` (+${oob} out of band)` : ''}</td><td>${esc(s.outcome || '')}</td><td class="mono">${esc(stamp(s.started))}</td><td class="mono">${esc(stamp(s.finished))}</td></tr>`;
  };
  const NOT_YET = 'not collected yet';
  const prHead = pr ? (pr.url ? `<a href="${esc(pr.url)}">#${pr.number}</a>` : `#${pr.number}`) : null;
  const prCell = !pr ? 'not yet opened' : !f ? `${prHead} · ${NOT_YET}` : `${prHead} · ${esc(f.state || '?')}${f.isDraft ? ' (draft)' : ''} · ${esc(f.reviewDecision || 'no decision')}`;
  const checksCell = !pr ? '—' : !f ? NOT_YET : f.checks ? `${f.checks.pass} ok · ${f.checks.fail} failing · ${f.checks.pending} pending of ${f.checks.total}` : NOT_YET;
  // The merge cell and the board's needs strip answer the same question, so they answer it from one
  // function (conflictRepair). This cell used to say "the resync step merges it back" while the
  // board offered `plt card rebase` for the same DIRTY fact: two pages of one system disagreeing
  // about the only action on offer. Naming the step is not enough either — the cell now carries the
  // command, so the reader does not have to guess how to reach it.
  const repair = f && f.mergeStateStatus === 'DIRTY' ? conflictRepair(st, inputs.effort || '', runId) : null;
  const mergeCell = !pr ? '—' : !f ? NOT_YET
    : `${repair ? `<span class="pill bad">🔀 CONFLICT</span> <span data-repair="${esc(repair.kind)}">main moved under ${esc(repair.subject)} — ${esc(repair.why)}: <code>${esc(repair.command)}</code></span>` : f.mergeStateStatus ? esc(f.mergeStateStatus) : '—'}${f.headSha ? ` · head ${esc(short(f.headSha))}` : ''}${f.threadsUnresolved ? ` · ${f.threadsUnresolved} thread${f.threadsUnresolved === 1 ? '' : 's'} unresolved` : ''}`;
  const cardLink = isUrl(inputs.pr) ? String(inputs.pr) : L.card(runId);
  const factsAt = f && f.at ? ` · facts as of ${esc(stamp(f.at))}Z${f.source === 'poll' ? ' (poll)' : ''}` : '';
  return `<title>${esc(runId)} Run Status</title>
<style>
${CSS_TOKENS}
.wrap{max-width:960px;margin:0 auto;padding-block:36px 80px;padding-inline:20px}a{color:var(--cycle)}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);margin:0 0 8px}
h1{font-family:var(--disp);font-size:30px;font-weight:700;margin:0 0 6px;letter-spacing:-.015em}h2{font-family:var(--disp);font-size:18px;font-weight:600;margin:36px 0 10px;padding-top:12px;border-top:1px solid var(--rule)}
.next{margin:18px 0;padding:14px 16px;border-radius:8px;background:${humanNeeded ? 'var(--gate-soft)' : 'var(--cycle-soft)'};border-left:4px solid ${humanNeeded ? 'var(--gate)' : 'var(--cycle)'};font-size:14.5px}.next code{font-family:var(--mono);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:8px;overflow:hidden;margin:16px 0}
.grid div{background:var(--surface);padding:11px 13px}.grid dt{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:0 0 3px}.grid dd{margin:0;font-size:14px;word-break:break-word}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px}th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--rule);background:var(--surface-2)}td{padding:8px 10px;border-bottom:1px solid var(--rule-soft);vertical-align:top}tr.cur td{background:var(--surface)}td.num,.mono{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:4px}.ok{background:var(--ok-soft);color:var(--ok)}.human{background:var(--gate-soft);color:var(--gate)}.wip{background:var(--cycle-soft);color:var(--cycle)}.bad{background:var(--bad-soft);color:var(--bad)}.mute{background:var(--surface-2);color:var(--ink-2)}.warn{background:var(--warn-soft);color:var(--warn)}
pre{font-family:var(--mono);font-size:12.5px;background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap}
.foot{margin-top:36px;padding-top:12px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink-3)}
</style>
<div class="wrap">
<p class="eyebrow">Run status · ${esc(st.cycle)} v${esc(st.formula_version)} · effort ${esc(inputs.effort || '')} · state as of ${lastEvent ? esc(stamp(lastEvent.ts)) + 'Z' : 'no events'}${factsAt}</p>
<h1>${esc(runId)} — ${esc(inputs.title || '')}</h1>
<div class="next"><b>${humanNeeded ? 'Needs you' : 'Next'}:</b> <code>${esc(nextCmd)}</code>${cur ? ` · step <b>${esc(cur)}</b> is <b>${esc(st.steps[cur].status)}</b>` : ''}</div>
<dl class="grid">
<div><dt>Card</dt><dd>${cardLink ? `<a href="${esc(cardLink)}">${esc(runId)}</a>` : esc(runId)} · owner ${esc(st.owner)}</dd></div>
<div><dt>Pull request</dt><dd>${prCell}</dd></div>
<div><dt>Checks</dt><dd>${checksCell}</dd></div>
<div><dt>Merge state</dt><dd>${mergeCell}</dd></div>
<div><dt>Dispatch brief</dt><dd>${(() => { const a = latest('dispatch-brief'); return a ? `<a href="${esc(a.ref)}">dispatch brief</a> · scope` : 'not yet published'; })()}</dd></div>
<div><dt>Approval artifact</dt><dd>${(() => {
    // Whichever the run's cycle produces. Naming only one meant a commit-review run
    // reported the page it was blocked on as missing.
    const pr = latest('pre-pr-summary'); const pc = latest('pre-commit-summary');
    const a = pr || pc; const label = pr ? 'pre-PR summary' : 'pre-commit summary';
    return a ? `<a href="${esc(a.ref)}">${label}</a>` : 'not yet published';
  })()}</dd></div>
<div><dt>Review responses</dt><dd>${rounds('review-response', 'round')}</dd></div>
<div><dt>Follow-on fix pages</dt><dd>${rounds('fix-summary', 'fix')}</dd></div>
<div><dt>Launched at</dt><dd class="mono">${esc(st.pin ? st.pin.kind + ':' + short(st.pin.value) : 'unpinned')} · estimate ${esc(st.estimate ? st.estimate.value + ' ' + st.estimate.unit : '—')}</dd></div>
<div><dt>Overlap</dt><dd>${overlap === 'clear' ? '<span class="pill ok">clear</span>' : /^n\/a/.test(overlap) ? esc(overlap) : `<span class="pill bad">${esc(overlap)}</span>`}</dd></div>
<div><dt>Gates</dt><dd>${gates.length ? gates.map((g) => `${esc(g.name)} by ${esc(g.by)} @ ${esc(short(g.pin && g.pin.value))}`).join('<br>') : 'none yet'}</dd></div>
<div><dt>Adversarial</dt><dd>${adversarial.length ? adversarial.map((a) => `${esc(a.name)}: <span class="pill ${a.verdict === 'pass' ? 'ok' : 'warn'}">${esc(a.verdict || 'n/a')}</span>`).join('<br>') : 'none'}</dd></div>
<div><dt>Signals</dt><dd>${extrapolations.length} extrapolation${extrapolations.length === 1 ? '' : 's'} · ${reprompts.length} re-prompt${reprompts.length === 1 ? '' : 's'}${outOfBand ? ` · ${outOfBand} receipt${outOfBand === 1 ? '' : 's'} out of band` : ''} · ${events.length} events</dd></div>
<div><dt>Last event</dt><dd class="mono">${esc(lastEvent ? stamp(lastEvent.ts) + ' ' + lastEvent.kind + (lastEvent.what ? ' ' + lastEvent.what : '') + (lastEvent.step ? ' · ' + lastEvent.step : '') : '—')}</dd></div>
</dl>
<h2>Steps</h2>
<div class="tw"><table><tr><th>Step</th><th>Status</th><th>Receipts</th><th>Outcome</th><th>Started</th><th>Finished</th></tr>${stepOrder.map(stepRow).join('')}</table></div>
${extrapolations.length ? `<h2>Extrapolations (schema tuning backlog)</h2><div class="tw"><table><tr><th>Step</th><th>Missing</th><th>Assumed</th></tr>${extrapolations.map((e) => `<tr><td>${esc(e.step)}</td><td>${esc(e.missing.scope)}:${esc(e.missing.key)}</td><td>${esc(spine.assumedText(e.assumed) || '—')}</td></tr>`).join('')}</table></div>` : ''}
<h2>Handoff</h2>
<pre>${esc(handoff.replace(/^---[\s\S]*?---\n/, '').trim() || 'none written')}</pre>
<p class="foot">Rendered by <code>plt render run ${esc(runId)}</code> from <code>process/runs/${esc(runId)}/state.yaml</code>, <code>events.jsonl</code>, <code>HANDOFF.md</code> and the facts snapshot <code>plt facts</code> keeps on the run. No hand-written state on this page.</p>
</div>
`;
}

// ---- build dir + manifest ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const buildDir = (processDir, out) => out || path.join(processDir, 'build');
const pageFile = (key) => (key === 'index' ? 'index.html' : `run-${key}.html`);

// renderAll(processDir, cfg) → { index: html, runs: { <id>: html } } — the page set writeBuild takes.
function renderAll(processDir, cfg) {
  cfg = cfg || spine.loadConfig(processDir);
  const runs = {};
  for (const id of runIds(processDir)) runs[id] = renderRun(processDir, id, cfg);
  return { index: renderIndex(processDir, cfg), runs };
}

// writeBuild(processDir, pages, {out}) — pages is { index?: html, runs?: { <id>: html } }; each present
// page is written to <out>/index.html or <out>/run-<id>.html. Returns { written: [{ key, path, sha256 }] }.
function writeBuild(processDir, pages, { out } = {}) {
  const dir = buildDir(processDir, out);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const put = (key, html) => { const p = path.join(dir, pageFile(key)); fs.writeFileSync(p, html); written.push({ key, path: p, sha256: sha256(html) }); };
  if (pages.index) put('index', pages.index);
  for (const [id, html] of Object.entries(pages.runs || {})) put(id, html);
  return { written };
}

function readManifest(dir) {
  const f = path.join(dir, 'publish.json');
  if (!fs.existsSync(f)) return { index: null, runs: {} };
  try { const m = JSON.parse(fs.readFileSync(f, 'utf8')); return { index: m.index || null, runs: m.runs || {} }; } catch (e) { return { index: null, runs: {} }; }
}
// Temp file + rename, so a reader never sees half a manifest. The one manifest writer:
// lib/publish.js writes through it too.
function writeManifest(dir, m) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'publish.json');
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

// publishManifest(processDir, {out}) — hashes every page in the build dir against the previous manifest.
// An entry is { sha, url?, published_sha?, changed }: `changed` is true when the page is new, when its
// sha differs from the last manifest, or — once `--published` has recorded a url — when it differs
// from the sha that was published (so a page that changed and was rendered twice stays listed until
// it is republished). `url`/`published_sha` are carried forward untouched. Returns the manifest plus
// `changed`: the keys ('index' or a run id) whose page the owner should republish.
function publishManifest(processDir, { out } = {}) {
  const dir = buildDir(processDir, out);
  const prev = readManifest(dir);
  const entry = (key, old) => {
    const f = path.join(dir, pageFile(key));
    if (!fs.existsSync(f)) return old;   // never rendered here — keep what we know
    const sha = sha256(fs.readFileSync(f, 'utf8'));
    const e = { sha, changed: !old || old.sha !== sha || (Boolean(old.published_sha) && old.published_sha !== sha) };
    if (old && old.url) e.url = old.url;
    if (old && old.published_sha) e.published_sha = old.published_sha;
    return e;
  };
  const m = { index: entry('index', prev.index), runs: {} };
  const ids = new Set([...Object.keys(prev.runs), ...fs.readdirSync(dir).map((f) => (f.match(/^run-(.+)\.html$/) || [])[1]).filter(Boolean)]);
  for (const id of [...ids].sort()) m.runs[id] = entry(id, prev.runs[id]);
  const changed = [...(m.index && m.index.changed ? ['index'] : []), ...Object.keys(m.runs).filter((id) => m.runs[id] && m.runs[id].changed)];
  writeManifest(dir, m);
  return { ...m, changed };
}

// recordPublished(processDir, key, url, {out, runId}) — the publishing session's hand-back: stores the
// url and the published sha on the manifest entry, clears its `changed`, and records the artifact receipt (`run-<id>` on that
// run; `effort-index` on `runId` when one is given) unless the same receipt/url is already the latest.
// A refused pin (dirty repo_dir) keeps the manifest write and reports the receipt as not recorded.
function recordPublished(processDir, key, url, { out, runId } = {}) {
  if (!key || !url) throw new Error('usage: --published <id|index> <url>');
  const dir = buildDir(processDir, out);
  const name = key === 'index' ? 'effort-index' : `run-${key}`;
  // The sha published is the sha of the page on disk — the bytes the publishing session just sent —
  // not the manifest's, which is stale when a caller wrote the page without publishManifest.
  // publish.recordPublished is the one writer of `published_sha`. With no page on disk the bytes are
  // unknown, so only the url is recorded and the page stays pending (publish.recordUrl).
  const publish = require('./publish');   // lazy: publish.js requires this module at load
  const page = path.join(dir, pageFile(key));
  if (fs.existsSync(page)) publish.recordPublished(processDir, key, { sha: sha256(fs.readFileSync(page, 'utf8')), url }, { out });
  else publish.recordUrl(processDir, key, url, { out });
  const receiptRun = key === 'index' ? runId : key;
  let receipt = null;
  if (receiptRun && spine.readState(processDir, receiptRun)) {
    const st = spine.readState(processDir, receiptRun);
    const last = spine.readEvents(processDir, receiptRun).filter((ev) => ev.kind === 'artifact' && ev.name === name).pop();
    if (last && last.ref === url) receipt = { run: receiptRun, name, recorded: false, why: 'already recorded' };
    else {
      let pin = null;
      try { pin = st.repo_dir && fs.existsSync(st.repo_dir) ? spine.computePin(st.repo_dir) : st.pin; } catch (err) { pin = st.pin; }
      if (!pin || pin.refused) pin = st.pin;
      if (!pin || pin.refused) receipt = { run: receiptRun, name, recorded: false, why: 'unpinnable tree and no launch pin' };
      else {
        const step = st.current_step || currentStep(st) || null;
        spine.recordReceipt(processDir, receiptRun, { step, kind: 'artifact', name, ref: url, pin, actor: 'human' });
        receipt = { run: receiptRun, name, recorded: true };
      }
    }
  }
  return { key, url, name, receipt };
}

module.exports = { renderIndex, renderRun, renderAll, writeBuild, publishManifest, recordPublished, links,
  sha256, buildDir, pageFile, readManifest, writeManifest };
