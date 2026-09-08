# Performance and visualization review

Baseline: `bb009a7`. Datasets: the bundled Latent Scope and React histories. Measurements were made locally with Node 23 and headless Chromium at a 1440 × 1100 viewport, device pixel ratio 1. Timings are indicative local measurements; draw calls and texture counts describe these specific scene states.

## Findings and changes

| Finding | Change |
| --- | --- |
| Seeking repeatedly loaded every preceding checkpoint. | Binary search selects one checkpoint; sequential playback reuses the preceding immutable state. |
| Every commit scanned all lots and reuploaded both complete building buffers. | Deltas visit touched paths, including rename origins. GPU updates cover only changed matrices and category/deletion colors; worker travel uploads no unchanged buildings. |
| Each district allocated a floor mesh and a 1024 × 192 label texture, with separate label draws. | Floors share one instanced mesh. Labels share atlas pages and instanced draws, and fade out below a readable size. |
| Expiring laser bursts disposed geometry/materials but retained instance buffers. | Instanced meshes now receive `dispose()` when effects expire and when scenes are replaced. |
| Turntable changes rendered through both the controls callback and the animation loop. | Each turntable frame renders once. Hover redraws only when the selected building changes. |
| Playback could advance only one commit per animation frame. | An elapsed-time clock processes every crossed commit, with bounded catch-up. |
| Staggered workers could reach the roof after the common laser delay; mixed changes placed workers above the actual roof. | Workers share arrival timing and follow current building height. Detailed and batched effects share one timestamp. |
| Large overlapping rings washed out action colors and obscured nearby files. | Rings are thinner, smaller, capped by both lot size and city average, and use ordinary alpha blending. |
| The canvas buffer used the padded shell width instead of its displayed width. | A canvas ResizeObserver drives matching render and projection dimensions. |
| Small-screen controls and the tall stage consumed too much space; the plain slider hid history structure. | A shorter responsive stage, compact header, accessible toggle states, endpoint buttons, and a bounded additions/removals overview improve navigation. |
| Tall files could extend beyond the frame. | Fit skyline frames the current building bounds while preserving linear LOC height; Reset restores the preset. |

Source/test colors remain separate from addition/removal colors. The history overview sums source/test changes into at most 240 bins, uses the same logarithmic scale for additions and removals, and explicitly describes commit grouping. Fixture/generated totals remain visible as final-snapshot totals outside the city. Authorship labels and extractor data invariants are unchanged.

## Measurements

Final replay state, equal-file layout, three-folder neighborhoods:

| Metric | Before | After |
| --- | ---: | ---: |
| React draw calls | 1,515 | 8 |
| React textures, including renderer environment texture | 498 | 5 |
| Latent Scope draw calls | 108 | 5 |
| Latent Scope textures | 36 | 2 |
| React pointer pick plus redraw, median | 8.9 ms | 0.4 ms |
| React late-history reconstruction, median | 1.1996 ms | 0.0230 ms |
| React final-commit city deltas, median | 0.1342 ms | 0.0009 ms |

CPU model measurements compare the baseline and current code in the same Node process, with warm-up and 200 samples. Reproduce with:

```bash
node scripts/benchmark_replay.mjs bb009a7
```

The browser comparison includes the corrected paused state (workers hidden) and corrected canvas sizing. These numbers are not claims about frame rate on all GPUs or phones.

## Verification

- Python extractor tests, Markdown export tests, city-model regression tests, TypeScript, and production build.
- Headless WebGL checks on both histories: exact final LOC for city paths, full-building picking, bounded label resources, and no browser/shader errors.
- Actual mixed, largest-addition, and largest-removal commits: workers on the roof before lasers, common effect timing, complete expiry, and no retained burst instance buffers.
- Sparse GPU uploads: travel leaves building buffers untouched; completed updates upload only touched instance matrices/colors.
- High-speed playback emits consecutive event indices; paused idle rendering stops; reduced-motion playback hides workers.
- All three layouts, neighborhood regrouping, skyline fitting, and mobile horizontal-overflow checks.
- Captured approach/strike/rebound frames and desktop/mobile final states for visual inspection.
- Production preview smoke check: React final state, skyline fitting, DPR-2 sampling cap, 320-pixel viewport, Markdown download, and no browser/shader errors.

Run the browser check as documented in the README. Screenshots and its JSON report default to `/tmp/repocity-validation`.

## Remaining limits

- The lazy-loaded Three.js scene chunk remains about 577 kB minified / 146 kB gzip, and Vite still reports its existing large-chunk warning. It is loaded separately from the initial UI.
- Replay JSON parsing and initial treemap construction still run on the main thread. Larger histories than the bundled React demo could justify moving them to a worker, after profiling that workload.
- Extreme LOC outliers remain tall because height stays linear and comparable. Fit skyline can make the surrounding city small; increasing Lines / block is another explicit viewing choice.
- Labels intentionally disappear when too small to read. Zoom in or use fewer neighborhood levels for more context; file hover preserves the full path.
- Validation used Chromium, including mobile viewport emulation. Physical mobile GPU behavior and other browser engines were not measured.
