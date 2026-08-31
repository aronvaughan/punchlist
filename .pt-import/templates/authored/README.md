# templates/authored/

The owner's own templates live here (`authored/<name>.md`), curated in
Obsidian or written with the workflow-writer skill (P4). Same format and
validation rules as packs: frontmatter, `## Output shape`, and a real
`## Golden exemplar` — `plt validate` enforces all three.

On a name collision, `plt show` prefers an authored template over a
shipped pack, so copying a pack template here is the supported way to
customize it.
