# RepoCity workflow

## Choose the input

Local checkout:

```bash
python3 scripts/build_replay.py /absolute/path/to/repo --ref origin/main
```

GitHub slug or URL:

```bash
python3 scripts/build_replay.py owner/repo --ref HEAD
python3 scripts/build_replay.py https://github.com/owner/repo.git --ref HEAD
```

Remote inputs are cloned with `--no-checkout` into a temporary directory. Git's configured credential helper handles private access. RepoCity deletes the temporary clone when generation finishes.

Do not guess a branch. For a local checkout, inspect:

```bash
git -C /path/to/repo branch --show-current
git -C /path/to/repo symbolic-ref refs/remotes/origin/HEAD
git -C /path/to/repo log -1 --format='%H %cI %s' REF
```

## Bound a monorepo

Start with read-only tree and size checks:

```bash
git -C /path/to/repo ls-tree -d --name-only REF
git -C /path/to/repo count-objects -vH
```

Select product paths rather than arbitrary file extensions. Keep shared packages only when they materially belong to the codebase being narrated.

```bash
python3 scripts/build_replay.py /path/to/repo \
  --ref REF \
  --include apps/product \
  --include packages/product-core \
  --exclude '**/fixtures/**' \
  --exclude '**/generated/**'
```

Excluding fixtures/generated paths removes them from the replay entirely. Without `--exclude`, they remain in summary totals but do not become buildings.

## Interpret generation output

The command prints commit/path counts and current LOC for source, tests, fixtures, and generated files. Investigate before presenting results when:

- fixture/generated LOC dominates source/test LOC;
- source or test LOC is zero for a code repository;
- the selected ref has unexpectedly few events;
- binary changes are numerous;
- final LOC validation fails.

Classification is configured in `public/repocity.config.json`. Regexes are case-insensitive and evaluated fixture, generated, test, docs, source, then config fallback.

## Validation sequence

```bash
npm run test:data
npm run typecheck
npm run build
git diff --check
```

Then run Vite and inspect the rendered canvas. Use `npm run dev:lan` only when another machine must reach the server; otherwise use `npm run dev`. Report the URL rather than opening a browser without the user's request.

For effect work, inspect at least:

- 1× with a small mixed add/remove commit;
- 1× with the largest commit;
- 32× or faster over a dense section;
- both Aerial and Isometric cameras;
- hover during playback and after the file disappears.

## Failures

`No commits found`: verify the ref and include paths with `git log REF -- PATH`.

`Replay LOC ... does not match Git tree LOC`: keep validation enabled while diagnosing. Check cross-boundary renames and pathspecs. `--no-validate` is for inspection, not a silent production workaround.

Empty city with nonzero totals: source/test classifiers do not match this repository, or the chosen paths contain only excluded categories.

WebGL startup error: confirm the browser supports WebGL2 and inspect the console before changing scene code.
