# RepoCity template checklist

1. Copy `template/repocity.config.json` to `public/repocity.config.json`.
2. Set the title, subtitle, palette, defaults, and repository-specific classifiers.
3. Generate `public/data/replay.json` with `scripts/build_replay.py`.
4. Inspect the printed source, test, fixture, generated, and binary totals.
5. Run `npm run test:data && npm run build`.
6. In a WebGL browser, check the first commit, a normal mixed add/remove commit, the largest addition, and the largest removal at both 1× and a high speed.

The root project is the application template; no framework-specific wrapper is required.
