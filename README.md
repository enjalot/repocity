# RepoCity

RepoCity turns a Git repository into a replayable Three.js code city. Files are lots, current lines of code are building height, and every first-parent commit can send robots and add/remove effects to the files it changes.

It is a standalone Vite + React application. The data builder uses only Git and Python's standard library: no GitHub API, pull-request data, hosted workflow metadata, or article framework is required.

## Quick start

Requirements: Git, Python 3.10+, and Node `^20.19.0 || >=22.12.0`.

```bash
npm install
python3 scripts/build_replay.py /path/to/repository --ref HEAD
npm run dev
```

Open the URL Vite prints. The default data destination is `public/data/replay.json`.

A public or authenticated GitHub repository can be used directly. RepoCity clones it into a temporary directory and removes the clone afterward:

```bash
python3 scripts/build_replay.py owner/repository --ref HEAD
python3 scripts/build_replay.py https://github.com/owner/repository.git --ref HEAD
```

For a large monorepo, select only the product directories that form one meaningful codebase:

```bash
python3 scripts/build_replay.py /path/to/monorepo \
  --ref origin/main \
  --include apps/product \
  --include packages/product-core \
  --exclude '**/fixtures/**' \
  --exclude '**/generated/**'
```

`--include` accepts Git pathspecs. `--exclude` accepts Git glob patterns and can be repeated.

## What the replay means

- The animated timeline follows the selected ref's first-parent history. Consecutive events therefore represent real tree-to-tree transitions.
- All commits reachable through merged branches are also recorded. Their explicit authorship signals are associated with the mainline event that first integrated them.
- Additions and removals are independent quantities. Deleting code is not represented as negative achievement.
- Source and test files become buildings by default. Documentation, config, fixtures, and generated files remain in the data summary but outside the city.
- Binary changes are counted separately because Git numstat cannot provide line counts for them.
- `unmarked` authorship means no configured agent or automation signal was found. It does not prove the commit was written manually.

The builder verifies reconstructed text LOC against the selected final Git tree. A mismatch fails generation unless `--no-validate` is supplied for diagnosis.

## Customize it

Copy [template/repocity.config.json](template/repocity.config.json) over `public/repocity.config.json`, then edit:

- title, subtitle, palette, default camera, animation speed, block size, and alley width;
- source/test/fixture/generated path classifiers;
- explicit agent and automation identity patterns.

The main customization seams are:

- `src/App.tsx` — controls, timeline choreography, labels, and page composition;
- `src/city/model.ts` — hierarchy, treemap algorithms, routes, and replay reconstruction;
- `src/city/threeScene.ts` — Three.js geometry, hit detection, robots, lasers, rings, and camera;
- `src/styles.css` — standalone presentation and color tokens.

Run these checks after changing the extractor or visualization:

```bash
npm run test:data
npm run typecheck
npm run build
```

## Use it as an agent skill

The repo includes `.agents/skills/repocity/SKILL.md`. Point an agent at that file or invoke `$repocity` from an environment that discovers repo-local skills.

Example:

> Use `$repocity` to build a standalone animated code city for `owner/repository`. Focus the monorepo on `apps/web` and `packages/core`, make tests gold and source violet, and verify the 1× robot/laser choreography in WebGL.

More command examples are in [examples/usage.md](examples/usage.md).
