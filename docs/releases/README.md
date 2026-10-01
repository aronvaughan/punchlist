# Releases

One file per public release, named by its tag (`v0.2.0.md`). The file is the squash commit's
message on the public repo, so it is written for a public reader: what changed and why, no internal
references. `scripts/publish.sh <version>` refuses to run without it and scans it like the tree.
