# Release notes

Notes for each punchlist release, newest first. Written for the reader
deciding whether and how to upgrade — highlights, breaking changes, exact
upgrade/verify commands, and a full-changelog link. Drafted with the
`av-release-notes` skill from the `release-notes` template, as the
[pre-push process](../2026-09-02-pre-push-process.md) release step.

| Version | Date | Stability | Notes |
| --- | --- | --- | --- |
| 1.0.1-rc.1 | 2026-09-02 | release candidate (`next`) | [v1.0.1](v1.0.1.md) |
| 1.0.0 | 2026-08-31 | stable (`latest`) | [v1.0.0](v1.0.0.md) |

## Versioning

npm has no "snapshots". A **candidate** is a SemVer prerelease published under
a dist-tag — `1.0.1-rc.1` on `next`, which never becomes `latest` until
promoted (`npm dist-tag add @aronvaughan/punchlist@1.0.1 latest`). `latest` is
what `npm install` gets by default; `next` is opt-in
(`npm install @aronvaughan/punchlist@next`).
