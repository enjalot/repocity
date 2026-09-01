# Visualization customization

## Prefer config first

`public/repocity.config.json` controls copy, palette, initial layout, camera, speed, effect duration, block size, alley width, path categories, and identity patterns. Regenerate replay JSON after changing anything under `classification`.

The source/test colors describe file roles. Add/remove colors describe actions. Keep those visual channels distinct.

## Layouts

`src/city/model.ts` creates a stable lot for every historical source/test file:

- `files`: equal file weight with D3 squarify; best for seeing file count and avoiding slivers;
- `peak`: historical peak LOC area with binary tiling; stable but can produce narrow lots;
- `squarify`: historical peak LOC area with squarified lots.

Height always represents current LOC divided by the selected lines-per-block setting. Lots use historical data so files can appear and disappear without reshuffling the city every commit.

Top-level Git folders become districts and receive floor labels. Routes start at the closest of four city corners and traverse district boundaries to the file lot.

## Three.js scene

`src/city/threeScene.ts` owns geometry, instancing, orthographic camera, floor labels, hit detection, workers, routes, lasers, rebounds, rings, and effect disposal.

Important invariants:

- pick against the full current building box, not only the roof;
- keep impact height at the current/target rooftop;
- additions and removals for one commit are separate adjacent actions;
- ring radius scales with change size but remains capped relative to average lot size;
- effect brightness/rebound scales with change size;
- at robot-visible speeds, delay the one laser effect until rooftop arrival and suppress the duplicate particle-route effect;
- at high speeds, hide robots but retain persistent translucent trails and an effect for every event passed.

If timing changes, keep playback duration and effect duration independent. The default 0.9-second laser uses a short neutral downward strike followed by a longer colored rebound/ring phase.

## App and styles

`src/App.tsx` owns data/config loading, playback state, controls, timeline, hover persistence, and scene lifecycle. Keep speed controls under the timeline so playback and effect pacing are adjusted where time is read.

`src/styles.css` is standalone and has no article or design-system dependency. Custom CSS variables are applied at the app root and read by the canvas when the scene is created.

## Adding categories to the city

The default city deliberately instantiates only source and test meshes. Adding docs/config/generated buildings is a code change, not just a new color: update `CityCategory`, tree filtering, mesh creation/indexing, legend, hit testing, and tests. Keep fixtures/generated disabled by default even if optional toggles are added.

## Visual verification

Unit tests and a successful build cannot validate animation choreography. Use a real WebGL browser and compare frames before impact, during the strike, and during rebound. Test small and monumental commits; large imports should create many localized effects without one small file producing a city-wide ring.
