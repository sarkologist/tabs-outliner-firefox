# Sidebar Projection Bug Hunt

This file records distinct bugs found by deterministic sidebar projection/hydration hunts.

Projection discovery is separate from runtime reconciliation trace hunting. Runtime `RT-*` findings stay in `RUNTIME_TRACE_BUGS.md`; projection findings use `PT-*`.

Run projection discovery with:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list
```

Fix passes must satisfy correctness and the hard projection perf gate:

```sh
pnpm perf:sidebar-projection-guard
```

## Last Projection Run

- Completed: 2026-05-26
- Strategy: continued remote projection hunt after clarifying stop rules; freshness, coverage-transition, rejected-response, broadcast ordering, command/delete broadcast, and temporal scroll/search/clear discovery
- Scenario ids: 41 `psh-*` Playwright discovery scenarios
- Distinct findings recorded: 11
- Status: `PT-008` through `PT-011` open; `PT-001` through `PT-007` fixed. Discovery stopped after three clean active mutation blocks following `PT-011`.
- Perf gate: preflight `pnpm perf:sidebar-projection-guard -- --smoke` passed before discovery. The final projection corpus pass had 37 green scenarios with the four frozen open failures excluded. Full fix-pass perf gate not run while `PT-008` through `PT-011` remain open.

## Fix Analysis

- `PT-001` and `PT-002`: sparse slice admission treated any returned slice as renderable and a rejected current request as terminal. The fix only renders sparse slices that cover the current viewport, merges non-covering slices without blanking the visible range, and retries one failed current-viewport request.
- `PT-003`, `PT-004`, and `PT-005`: sparse viewport ownership was lost when full hydration, full broadcasts, or unloaded-row compact patches rebuilt projection state. The fix records user sparse-scroll intent, suppresses one active-tab recenter on hydration/broadcast, preserves an already rendered row window only when it intersects the current viewport, and ignores unloaded-node collapsed deltas.
- `PT-006`: sparse tree-structure broadcasts requested a remote projection refresh before applying the visible projection patch. The fix tries compact visible-row projection updates first and only falls back to a background slice when the local patch cannot safely apply.
- `PT-007`: remote projection application could scroll to an active/reveal target outside the returned sparse rows and then stop, leaving the viewport blank until another scroll. The fix immediately asks for a viewport-covering sparse slice after remote projection rendering changes scroll position.
- `PT-008`: fix analysis pending. Discovery shows a partial sidebar-local search projection can recompute chrome from the partial node table after a visible match stops matching.
- `PT-009`: fix analysis pending. Discovery shows a sparse snapshot without coverage metadata can keep visible-row actions readonly even after full hydration resolves.
- `PT-010`: fix analysis pending. Discovery shows a rejected show-in-tree target slice can leave cleared search input paired with stale search-result chrome.
- `PT-011`: fix analysis pending. Discovery shows a rejected clear-search projection slice can leave cleared search input paired with stale search-result chrome.

## Finding Index

- Fixed projection findings: `PT-001`, `PT-002`, `PT-003`, `PT-004`, `PT-005`, `PT-006`, `PT-007`
- Open projection findings: `PT-008`, `PT-009`, `PT-010`, `PT-011`

### PT-001 rejected sparse slice leaves viewport blank/no retry

- Status: fixed
- Found by: `psh-scroll-rejected-slice-recovers-without-second-user-scroll`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-scroll-rejected-slice-recovers-without-second-user-scroll" --reporter=list
```

- Expected: after a `getTreeProjectionSlice` request rejects, the sidebar should request or retry the current viewport slice and repaint without requiring another user scroll.
- Actual: the sparse request count remains `1`, and the scrolled viewport stays blank.
- Evidence: the scenario rejects the first sparse slice after scrolling to row `250`; after idle frames, Playwright observes no retry and no visible row `250`.

### PT-002 non-covering sparse slice can blank a previously covered viewport

- Status: fixed
- Found by: `psh-stale-covering-window-survives-latest-noncovering-slice`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-stale-covering-window-survives-latest-noncovering-slice" --reporter=list
```

- Expected: once the current viewport is painted from a covering sparse slice, a later non-covering sparse response should be ignored or followed by a new current-viewport request.
- Actual: the later non-covering response replaces the sparse projection and the current viewport becomes empty.
- Evidence: after scrolling near row `260`, the test first resolves a covering slice for rows `240..309`, then resolves another pending slice for rows `700..759`; visible rows become `[]`.

### PT-003 full hydration does not recover a viewport blanked by rejected sparse slice

- Status: fixed
- Found by: `psh-full-state-broadcast-recovers-after-rejected-slice`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-full-state-broadcast-recovers-after-rejected-slice" --reporter=list
```

- Expected: if a sparse slice fails while full hydration is pending, the eventual full `getState` response should render the scrolled viewport without another user scroll.
- Actual: the viewport remains empty after full-state resolution.
- Evidence: after scrolling to row `250`, rejecting the sparse request, and resolving the delayed full state, Playwright still observes no visible row `250`.

### PT-004 full `stateUpdated` broadcast jumps a sparse-scrolled viewport back to active rows

- Status: fixed
- Found by: `psh-state-updated-while-scrolled-to-sparse-window-preserves-viewport`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-state-updated-while-scrolled-to-sparse-window-preserves-viewport" --reporter=list
```

- Expected: after the user scrolls to and paints a sparse slice, a full `stateUpdated` broadcast should preserve the current viewport.
- Actual: the visible rows jump from around row `250` back near the active initial rows.
- Evidence: before the broadcast, Playwright observes row `250`; after the broadcast, `visibleRows` no longer contains row `250` and instead reports rows near `787..`.

### PT-005 unloaded node-state patch collapses/jumps a sparse-scrolled viewport

- Status: fixed
- Found by: `psh-unloaded-title-patch-preserves-visible-sparse-window`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-unloaded-title-patch-preserves-visible-sparse-window" --reporter=list
```

- Expected: a compact `nodeStateUpdated` patch for an unloaded row should not disturb the currently visible sparse slice.
- Actual: after the unloaded title patch, the viewport no longer contains row `250` and jumps to a different partial row range.
- Evidence: before the patch, Playwright observes row `250`; after patching unloaded `tab:900`, visible rows move to roughly `120..`.

### PT-006 sparse tree-structure patch leaves deleted visible row stale

- Status: fixed
- Found by: `psh-patch-delete-hovered-row-clears-visible-actions` and `psh-visible-sparse-delete-patch-keeps-neighbor-visible`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-patch-delete-hovered-row|psh-visible-sparse-delete" --reporter=list
```

- Expected: a `treeStructureUpdated` broadcast for a visible sparse row should remove the deleted row and keep neighboring visible rows painted without waiting for another projection slice.
- Actual: sparse sidebars requested a remote refresh before applying the compact delete patch, so the deleted visible row stayed in the DOM.
- Evidence: Playwright observed `tab:800` or `tab:250` still present after the delete broadcast.

### PT-007 clear-search remote projection can blank viewport until next scroll

- Status: fixed
- Found by: `psh-clear-search-ignores-stale-query-response`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-clear-search-ignores-stale-query-response" --reporter=list
```

- Expected: clearing search while a stale query response is pending should leave the search box clear, preserve the normal outline count, and paint the current viewport without a manual nudge.
- Actual: the cleared non-search projection could render rows near the top, scroll to the active row outside that sparse slice, and stop with no visible rows.
- Evidence: after resolving the stale query response and the clear-search response, Playwright saw the clear state but no viewport-visible rows until a follow-up sparse request was forced.

### PT-008 search prune falls back to partial sidebar-local counts

- Status: open
- Found by: `psh-search-prunes-visible-row-after-title-stops-matching`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-search-prunes-visible-row-after-title-stops-matching" --reporter=list --workers=1
```

- Expected: while full hydration is pending, if a visible search result receives a title patch that makes it stop matching, the row should disappear and the search chrome should preserve the authoritative background total: `0 matches / 1001 items`.
- Actual: the row disappears, but the sidebar falls back to a projection built from its partial local node table and reports `0 matchs / 82 items`.
- Evidence: the frozen Playwright scenario first resolves a remote search for `Tab 900`, then emits a `nodeStateUpdated` title patch changing that tab to `Renamed away from query`; after idle frames, the DOM no longer contains `tab:900`, but `#state-count` is computed from the sparse sidebar-local state instead of the background-owned projection metadata.

### PT-009 missing coverage snapshot stays readonly after full hydration

- Status: open
- Found by: `psh-coverage-missing-snapshot-restores-actions-after-full-hydration`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-coverage-missing-snapshot-restores-actions-after-full-hydration" --reporter=list --workers=1
```

- Expected: a sparse initial snapshot without coverage metadata should keep actions readonly while full hydration is pending, then restore normal visible-row actions once full `getState` hydration resolves.
- Actual: after full hydration resolves and the row is hovered again, the visible row still has no `Close` action.
- Evidence: the frozen Playwright scenario loads a sparse snapshot with `includeCoverage: false`, verifies `tab:799` has no `Close` action while partial, resolves full state, waits idle frames, hovers `tab:799` again, and times out waiting for the `Close` button.

### PT-010 rejected show-in-tree target leaves stale search chrome

- Status: open
- Found by: `psh-show-in-tree-rejected-target-response-restores-cleared-outline`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-rejected-target-response-restores-cleared-outline" --reporter=list --workers=1
```

- Expected: after clicking `Show in tree`, the search input is cleared. If the target-node projection request rejects, the sidebar should restore or keep a non-search outline projection with normal outline chrome.
- Actual: the search input is empty, but the sidebar still displays stale search-result chrome: `1 match / 1001 items`.
- Evidence: the frozen Playwright scenario searches for `Tab 900`, resolves that search result, clicks `Show in tree`, rejects the pending target-node slice, waits idle frames, and observes empty `#search` with search-result count text instead of `1001 items / 0 saved`.

### PT-011 rejected clear-search slice leaves stale search chrome

- Status: open
- Found by: `psh-clear-search-rejected-response-restores-outline-chrome`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-clear-search-rejected-response-restores-outline-chrome" --reporter=list --workers=1
```

- Expected: after clearing search, if the non-search projection slice rejects, the sidebar should still restore or keep non-search outline chrome matching the cleared search input.
- Actual: the search input is empty, but the sidebar still displays stale search-result chrome: `1 match / 1001 items`.
- Evidence: the frozen Playwright scenario searches for `Tab 900`, resolves that search result, clicks clear search, rejects the pending non-search projection slice, waits idle frames, and observes empty `#search` with search-result count text instead of `1001 items / 0 saved`.
