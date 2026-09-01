---
name: repocity
description: Build or customize a standalone animated Three.js code city from a local or GitHub repository's Git history. Use for replayable file/LOC treemaps, commit robots and add/remove effects, test-versus-source views, or adapting RepoCity to a monorepo; do not use for PR/workflow analytics that require hosting-provider APIs.
---

# RepoCity

Work from the RepoCity repository root. The analyzed repository is read-only input; generate data only inside RepoCity unless the user chooses another output.

## Build a city

1. Resolve the repository and ref. A local path, Git URL, or `owner/repository` slug is accepted. For a monorepo, inspect its tree and choose coherent `--include` paths before generating a large replay.
2. Copy `template/repocity.config.json` to `public/repocity.config.json` when starting a new customization. Set the title/palette and adjust classifiers before changing rendering code.
3. Run the extractor:

   ```bash
   python3 scripts/build_replay.py REPOSITORY --ref REF --output public/data/replay.json
   ```

   Add repeatable `--include PATHSPEC` and `--exclude GLOB` filters when needed. Read [references/workflow.md](references/workflow.md) for exact local, remote, and monorepo commands and failure handling.
4. Inspect the printed category totals. Fixtures/generated content belongs in the caveat summary, not the default source/test city. If source or test totals look wrong, fix classification patterns and regenerate.
5. Install and validate:

   ```bash
   npm install
   npm run test:data
   npm run typecheck
   npm run build
   ```

6. Render the app in a WebGL browser. Check hit detection, tooltips, first and final states, a normal mixed add/remove commit, and the largest add/remove events. At 1×, robots must reach the roof before their laser begins; at high speed, every crossed commit must still emit effects.

## Preserve these invariants

- Animate first-parent events because adjacent events must be real tree states. Keep all reachable commits as metadata and aggregate explicit signals from branch commits into the event that integrates them.
- Keep additions and removals separate. A large deletion is meaningful work, not negative growth.
- Treat binary files separately and verify final text LOC against Git.
- Never rename `unmarked` authorship to `human` or `manual`; absence of an explicit signal proves neither.
- Do not add GitHub PR, issue, factory, workspace, or article-framework dependencies to the generic path.
- Keep source/test building colors distinct from add/remove effect colors.

## Customize deliberately

Read [references/customization.md](references/customization.md) before changing layouts, categories, lasers, robots, timing, or camera behavior. Read [references/replay-schema.md](references/replay-schema.md) before changing the extractor or JSON contract.

Prefer configuration changes for names, colors, defaults, path categories, and identity patterns. Edit the model or Three.js scene only when the requested behavior cannot be expressed in `public/repocity.config.json`.
