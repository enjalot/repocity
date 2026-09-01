# RepoCity agent guidance

Use `.agents/skills/repocity/SKILL.md` when generating or customizing a code-city replay.

Keep the project standalone. Do not add Moonshine, article-rendering, GitHub API, pull-request, or organization-specific workflow dependencies. The extractor must remain read-only with respect to the analyzed repository.

Preserve these data invariants:

- first-parent events are real consecutive repository states;
- additions and removals remain separate;
- fixture/generated categories stay visible in summaries but outside the default city;
- `unmarked` authorship is not labeled manual;
- final reconstructed LOC is checked against the selected Git tree.

Use `apply_patch` for edits. Validate Python tests, TypeScript, the production build, and the rendered WebGL behavior after visual-effect changes.
