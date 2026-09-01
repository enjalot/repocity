# Example usage

## A local repository

```bash
python3 scripts/build_replay.py ../my-repository --ref origin/main
npm run dev
```

## A GitHub repository

```bash
python3 scripts/build_replay.py owner/repository --ref HEAD --pretty
npm run build
```

Git uses the machine's normal credential helper, so the same command works for a private repository when the user already has clone access.

## A large monorepo

Inspect top-level directories first:

```bash
git -C /path/to/monorepo ls-tree -d --name-only origin/main
```

Then select a coherent subtree and omit artifacts that would dominate the replay:

```bash
python3 scripts/build_replay.py /path/to/monorepo \
  --ref origin/main \
  --name product-name \
  --include apps/product \
  --include packages/product-api \
  --exclude '**/fixtures/**' \
  --exclude '**/snapshots/**' \
  --exclude '**/generated/**'
```

The paths remain repository-relative in tooltips so provenance stays inspectable.

## Tune classification before changing code

If tests are colored as source, add a regex to `classification.testPatterns` in `public/repocity.config.json` and regenerate the replay. Classification is evaluated in this order:

1. fixture
2. generated
3. test
4. docs
5. source
6. config fallback

This order intentionally prevents a fixture named `test_data.py` from entering the test-city headline.

## Example agent prompt

> Read `.agents/skills/repocity/SKILL.md`, build a RepoCity replay for `/work/acme`, use `origin/main`, restrict the monorepo to `services/api` and `web/client`, and customize the title and palette. Keep fixture/generated LOC in the caveat summary. Run the data tests, production build, and a browser/WebGL choreography check.
