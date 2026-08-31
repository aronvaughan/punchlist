# templates/packs/

Template packs shipped with the product. Each pack is a directory of
template markdown files (`packs/<pack>/<name>.md`). Do not edit packs to
customize — copy the template into `templates/authored/` and edit there;
`plt show` prefers authored templates over packs on a name collision.

Every template must pass `plt validate` — see the repo README for the
format (frontmatter + `## Output shape` + `## Golden exemplar`).
