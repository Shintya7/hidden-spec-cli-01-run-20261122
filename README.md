# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads them all: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed or nothing is.

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or standard input when it is absent or `-`.
`--format` names one format (`unified`, `search-replace`, `v4a`, `json`) or `auto`
(the default), which detects it. `--check` does everything but write. `--strict`
matches lines exactly. The working directory is the root of the tree.

Lines are found at the first of three matching tiers: exact, ignoring trailing
spaces and tabs, then ignoring leading and trailing spaces and tabs (re-indenting
new lines to the file's own indent). Unified hunks take the occurrence nearest
their line number, SEARCH/REPLACE blocks need exactly one, and V4A chunks walk a
cursor through the file with anchors.

Node 22 and its standard library only; no dependencies, no install step.
