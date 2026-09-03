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

To keep several generated cities available from one dev server, give each replay a short filename and select it with `?dataset=NAME`:

```bash
python3 scripts/build_replay.py enjalot/latent-scope --ref HEAD \
  --output public/data/latent-scope.json
python3 scripts/build_replay.py earendil-works/pi --ref HEAD \
  --output public/data/pi.json
npm run dev:lan
```

For example, `http://localhost:5173/?dataset=latent-scope` loads the matching entry from `public/demos.json`. Without a catalog entry, RepoCity falls back to `public/data/latent-scope.json`. Dataset names may contain letters, numbers, dots, underscores, and hyphens.

A public or authenticated GitHub repository can be used directly. RepoCity clones it into a temporary directory and removes the clone afterward:

```bash
python3 scripts/build_replay.py owner/repository --ref HEAD
python3 scripts/build_replay.py https://github.com/owner/repository.git --ref HEAD
```

Remote clones use a filtered, single-branch checkout by default. Git shows clone progress, downloads blobs up to 1 MiB up front, and retrieves unusually large blobs only if replay validation needs them.

Very large repositories can use an explicitly bounded remote history. A shallow replay begins with the complete selected-path snapshot at the shallow boundary, so it remains internally consistent but does not claim to show the repository's genesis:

```bash
python3 scripts/build_replay.py owner/very-large-monorepo \
  --ref master \
  --clone-depth 5000 \
  --clone-filter tree:0 \
  --include products/example \
  --name example
```

Partial-clone filter support varies by Git server. Stop the clone if Git warns that filtering is ignored or the remote starts enumerating the full repository, then use a smaller upstream mirror or an existing local clone.

RepoCity's open-source smoke-test targets include [Latent Scope](https://github.com/enjalot/latent-scope) and the [Pi agent harness](https://github.com/earendil-works/pi):

```bash
python3 scripts/build_replay.py enjalot/latent-scope --ref HEAD
python3 scripts/build_replay.py earendil-works/pi --ref HEAD
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

## Public demos and GitHub Pages

The tracked demo catalog includes four deliberately different histories:

| Demo | History represented |
| --- | --- |
| [Latent Scope](https://github.com/enjalot/latent-scope) | Full history; compact visualization tool |
| [Pi](https://github.com/earendil-works/pi) | Full history; medium-sized agent harness |
| [FastAPI](https://github.com/fastapi/fastapi) | Full history; Python and test-heavy |
| [React](https://github.com/facebook/react) | Full history; large, long-lived JavaScript monorepo |

Each replay is LOC-validated before packaging. `scripts/package_demo.py` validates the replay shape and creates deterministic gzip data for static hosting:

```bash
python3 scripts/build_replay.py facebook/react --ref HEAD \
  --name react --output /tmp/react.json
python3 scripts/package_demo.py /tmp/react.json public/data/react.json.gz
```

`public/demos.json` records each snapshot commit, scope, and event count. The browser decompresses these files as streams, cutting transfer size substantially without requiring server-specific headers.

The included `.github/workflows/pages.yml` tests and builds the app, uploads `dist`, and deploys it with GitHub's Pages actions. In the repository settings, select **GitHub Actions** as the Pages source. Vite emits project-relative asset URLs, so the build works at `https://OWNER.github.io/REPOSITORY/` as well as at a custom domain.

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

- title, subtitle, palette, default camera, animation speed, block size, alley width, and neighborhood depth;
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

For large histories, RepoCity stores periodic checkpoints, reuses parsed first-appearance metadata, updates only files touched by each sequential commit, bounds accumulated effects, stops idle animation frames, and lowers WebGL sampling for cities above 6,000 lots. Laser and trail effects always last 0.9 seconds; timeline speed remains independent.

## Use it as an agent skill

The repo includes `.agents/skills/repocity/SKILL.md`. Point an agent at that file or invoke `$repocity` from an environment that discovers repo-local skills.

Example:

> Use `$repocity` to build a standalone animated code city for `owner/repository`. Focus the monorepo on `apps/web` and `packages/core`, make tests gold and source violet, and verify the 1× robot/laser choreography in WebGL.

More command examples are in [examples/usage.md](examples/usage.md).
