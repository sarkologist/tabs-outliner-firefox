# Sidebar Startup Scroll-Away Autoresearch

This is the local autoresearch setup for the sparse-startup scroll-away gap. After first paint, the sidebar may show a 256-row active-centered sparse projection while full hydration is delayed. If the user scrolls outside that sparse window before hydration completes, the current implementation has full tree height but no DOM rows in the new viewport.

## Setup

1. Choose a run tag based on today's date, for example `20260522-scroll-away`.
2. Work on a feature branch.
3. Run the baseline:
   `pnpm profile:startup-scroll-away -- --runs 5 --tag <tag> --description "baseline" --append-results`
4. Keep `autoresearch/sidebar-startup-scroll-away/results.tsv` and ad hoc logs untracked.

## Metric

Primary score: current viewport row coverage after scrolling away from the initial sparse projection while full hydration is unresolved.

The deterministic profile starts with a sparse active-centered snapshot around row `40000`, keeps `getState` unresolved, scrolls to row `10000`, waits two animation frames, and emits `startup-scroll-away`.

Target budgets:

- `hydrationRequestsMax === 0`
- `visibleRowsMin >= floor(expectedViewportRowsMedian * 0.8)`
- `missingViewportRowsMax === 0`
- `rowsVisibleMsMax < 32`
- `scrollDelayMaxMs < 8`

Baseline on 2026-05-22 before sparse row-window paging is expected to be `discard`: visible rows after scroll are `0`, missing viewport rows remain nonzero, and `rowsVisibleMsMax` is absent because no row appears within the two-frame window.

## Experiment Loop

Repeat one hypothesis at a time:

1. Read the current loop summary and profile JSON.
2. Add or update a failing behavior test first when changing behavior. For the likely fix, that means asserting a sparse window request can fill the current viewport without full hydration.
3. Make the smallest implementation change.
4. Run:
   `pnpm run build`
   `pnpm profile:startup-scroll-away -- --runs 5 --tag <tag> --description "<short idea>" --append-results`
   `pnpm profile:startup-hover-loop -- --runs 5 --tag <tag>-hover-guard --description "<short idea> hover guard"`
5. Keep the experiment only if scroll-away status is `keep` and the existing startup-hover loop stays `keep`.
6. If the result is worse or ambiguous, revert only the experiment changes and try the next hypothesis.

## Likely Implementation Direction

- Add a background command that returns a sparse tree window by row range or center row, without transporting full state.
- On sparse startup scroll, calculate the visible row range from `scrollTop / rowHeight`.
- If the viewport is outside the loaded sparse rows, request that row window and render it immediately.
- Prefetch adjacent sparse windows in scroll-distance order after the visible window.

## Safety

- Do not trigger full `getState` just to fill the scrolled viewport.
- Do not expand the initial startup snapshot beyond 256 rows/nodes for this target.
- Do not add saves, full-state broadcasts, or runtime-event processing to the scroll-away path.
- Keep the hover/startup interaction budgets green; the fix should add coverage, not bring back startup hover jank.
