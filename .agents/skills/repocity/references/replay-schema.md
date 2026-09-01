# Replay schema

`public/data/replay.json` is compact JSON with these top-level fields:

- `version`, `repo`, `ref`, `tip`, `start`, `end`
- `definitions`: metric and attribution caveats suitable for UI copy
- `people`: deduplicated display names and `agent`, `automation`, or `unmarked` identity kinds; emails are not exported
- `paths`: stable integer IDs, repository-relative path, category, peak LOC, final LOC
- `commits`: every reachable selected-path commit, including branch commits
- `events`: first-parent tree transitions used by animation
- `checkpoints`: periodic sparse LOC snapshots for fast random access
- `summary`: current LOC/files by category plus binary-change counts

## Event changes

Each change is a positional tuple:

```text
[pathId, additions, removals, status, oldPathId]
```

Status codes:

| Code | Meaning |
| ---: | --- |
| 1 | added |
| 2 | modified |
| 3 | deleted |
| 4 | renamed |
| 5 | copied |
| 6 | type changed |

`oldPathId` is `-1` unless a rename/copy has an old path. Additions and removals are non-negative Git numstat values.

## Reconstruction

`reconstruct(replay, eventIndex)` loads the last checkpoint at or before the requested event, then applies later tuples. A rename transfers the old file's current LOC before applying its add/remove delta. A deletion sets current LOC to zero; the historical lot remains available for a stable layout and tooltip.

Checkpoints are sparse `[pathId, lines]` pairs. Do not serialize zero-value files.

## Attribution

Event `signals` are explicit markers from author/committer identities or `Co-Authored-By` trailers. For a merge event, signals also include newly reachable branch commits integrated by that first-parent event.

`authorship` values are `agent-assisted`, `automation`, or `unmarked`. The schema intentionally has no inferred `manual` value.

## Contract changes

When changing tuple order, status semantics, checkpoint shape, or reconstruction rules, update the Python tests and TypeScript model together. Increment `version` for incompatible output.
