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

- Started: 2026-05-27
- Strategy: collapsed-boundary hunt after the PT-035 fix, focused on drag/drop and local action coverage across collapsed ancestors, hidden children, and non-visible sibling order without automatic full hydration.
- Last completed run scenario ids: 184 `psh-*` Playwright discovery/regression scenarios before this hunt; this discovery checkpoint adds 8 more `psh-*` scenarios for 192 total.
- Distinct findings recorded: 36
- Status: `PT-001` through `PT-031` and `PT-033` through `PT-035` are fixed; `PT-036` and `PT-037` are open from the active collapsed-boundary hunt. The sparse action follow-up hunt suspected `PT-032` around rename/search replacement, but the follow-up fix pass retracted it as a harness-ordering false positive and kept the corrected scenarios as required-passing coverage.
- Clean blocks after latest finding: 0 after `PT-037`. Discovery must continue until three full active mutation blocks find no new distinct projection signature.
- Verification: preflight `pnpm run build`, the 184-scenario projection corpus, and `pnpm perf:sidebar-projection-guard -- --smoke` passed before this hunt. Block 0 added collapsed-parent inside-drop coverage; `psh-collapsed-parent-inside-drop-covered-child-order-sends-command` passed, while `psh-collapsed-parent-inside-drop-missing-child-order-refills` exposed `PT-036`. Block 1 added search-visible hidden-child drag/drop and multi-sidebar coverage; covered cases passed and the missing-coverage case duplicated `PT-036`. Block 2 added collapsed-boundary expand/collapse patch coverage; collapse of already loaded children passed, while expansion exposed `PT-037`. After freezing the findings, `pnpm run build`, the full 192-scenario projection corpus, and `pnpm perf:sidebar-projection-guard -- --smoke` passed.

## Fix Analysis

- `PT-001` and `PT-002`: sparse slice admission treated any returned slice as renderable and a rejected current request as terminal. The fix only renders sparse slices that cover the current viewport, merges non-covering slices without blanking the visible range, and retries one failed current-viewport request.
- `PT-003`, `PT-004`, and `PT-005`: sparse viewport ownership was lost when full hydration, full broadcasts, or unloaded-row compact patches rebuilt projection state. The fix records user sparse-scroll intent, suppresses one active-tab recenter on hydration/broadcast, preserves an already rendered row window only when it intersects the current viewport, and ignores unloaded-node collapsed deltas.
- `PT-006`: sparse tree-structure broadcasts requested a remote projection refresh before applying the visible projection patch. The fix tries compact visible-row projection updates first and only falls back to a background slice when the local patch cannot safely apply.
- `PT-007`: remote projection application could scroll to an active/reveal target outside the returned sparse rows and then stop, leaving the viewport blank until another scroll. The fix immediately asks for a viewport-covering sparse slice after remote projection rendering changes scroll position.
- `PT-008`: partial search projection patching now separates the visible row patch from authoritative projection totals. When a visible search result stops matching before full hydration completes, the sidebar prunes rows from the partial state but preserves the last background-owned node and match counts while scheduling a fresh remote search projection.
- `PT-009`: sparse initial snapshots without coverage metadata now keep partial rows readonly without hydrating on startup. If the user asks for coverage-dependent affordances from that snapshot, the sidebar requests full hydration once and restores normal visible-row actions when it resolves.
- `PT-010` and `PT-011`: cleared-search intent is no longer coupled to the last successful search projection. The sidebar remembers the last accepted outline projection and restores it when a cleared-search or show-in-tree remote projection request is rejected, so stale search chrome does not survive a failed follow-up request.
- `PT-012`: visible sparse deletes could locally remove enough rows to expose an unpainted viewport tail. The fix invalidates in-flight sparse slices after local tree-structure patches, forces a current-intent viewport refill after applying the compact patch, and treats a successful show-in-tree response that no longer contains the requested node as stale.
- `PT-013`: sparse hydrating action gating hid edit controls that can safely begin from covered rows. The fix restores Cut and Move to top level for editable sparse rows; Cut marks the row locally and starts full hydration so placement-dependent Paste/drag affordances can recover with whole-tree state.
- `PT-014` and `PT-015`: sparse and remote projection responses were compared mostly against the last rendered projection, so older responses could still take visible ownership after the user had changed intent through search or clear-search. The fix captures a sidebar-local projection intent for sparse, search, clear-search, and show-in-tree requests; only current-intent responses can replace the visible projection, while stale responses may still merge safe partial node data. Clear-search also asks for the current outline viewport instead of row zero, so recovery does not depend on a later scroll.
- `PT-016` through `PT-021`: target-node, search, clear-search, and sparse-scroll flows still shared too much "last rendered rows" state. The fix gives each visible projection a sidebar-local owner (`outline`, `search`, or `showInTree`) with normalized query/target semantics; only responses captured under the current owner may own the visible projection. Accepted show-in-tree reveals keep an active reveal target across background refills, outline fallback memory excludes target-centered slices, sparse scroll intent suppresses active-tab recentering, and hover action preservation now requires current coverage proof so old action strips cannot leak across owner changes.
- `PT-022` through `PT-030`: owner identity was guarded, but rows, viewport anchor, chrome metadata, coverage, and outline fallback memory could still drift independently during compact patches, refills, and clear/search/show-in-tree transitions. The fix admits projection updates as coherent frames: current-owner responses may replace visible rows and frame metadata, stale responses only merge safe node data, owner/frame changes replace coverage rather than inheriting it, same-owner sparse expansions are the only path that merges coverage, outline fallback excludes search/target frames, and missing-coverage hydrating rows stay edit-readonly until coverage or full hydration proves action authority.
- `PT-031`: drag/drop still had a pre-sparse-rewrite blanket full-hydration guard, so covered local rows were draggable in the DOM but rejected by the event handlers while `hydratingFullState` remained true. The fix makes drag/drop admission coverage-aware: covered local source/target/root placements can send the background move command without full hydration, while missing coverage blocks the attempt and requests a sparse refill instead of `getState`.
- `PT-033`: delayed closed-restore scope responses lacked a post-await validity check against current sidebar state. The fix admits a restore scope only while the target still exists, is still closed, and any known scoped rows are still closed; the same check runs again after the confirmation prompt before sending the restore command.
- `PT-034`: state-change refresh after a history/title patch could demote a pending show-in-tree owner into a generic outline sparse refill before the target response arrived. The fix treats a pending show-in-tree request as the current projection owner during state-change refresh, so unrelated patches do not steal visible ownership before the target slice settles.
- `PT-035`: the `PT-033` restore-scope guard still treated all missing scoped nodes as merely unknown sparse data. The fix snapshots the node ids known to the sidebar before the async restore-scope request starts; if a node that was locally known at request time is missing or no longer closed when the delayed scope resolves, the scope is stale and no confirmation prompt or restore command is allowed.

## Finding Index

- Fixed projection findings: `PT-001`, `PT-002`, `PT-003`, `PT-004`, `PT-005`, `PT-006`, `PT-007`, `PT-008`, `PT-009`, `PT-010`, `PT-011`, `PT-012`, `PT-013`, `PT-014`, `PT-015`, `PT-016`, `PT-017`, `PT-018`, `PT-019`, `PT-020`, `PT-021`, `PT-022`, `PT-023`, `PT-024`, `PT-025`, `PT-026`, `PT-027`, `PT-028`, `PT-029`, `PT-030`, `PT-031`, `PT-033`, `PT-034`, `PT-035`
- Open projection findings: `PT-036`, `PT-037`
- Retracted projection suspicions: `PT-032`

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

- Status: fixed
- Found by: `psh-search-prunes-visible-row-after-title-stops-matching`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-search-prunes-visible-row-after-title-stops-matching" --reporter=list --workers=1
```

- Expected: while full hydration is pending, if a visible search result receives a title patch that makes it stop matching, the row should disappear and the search chrome should preserve the authoritative background total: `0 matches / 1001 items`.
- Actual before fix: the row disappeared, but the sidebar fell back to a projection built from its partial local node table and reported `0 matchs / 82 items`.
- Evidence: the frozen Playwright scenario first resolves a remote search for `Tab 900`, then emits a `nodeStateUpdated` title patch changing that tab to `Renamed away from query`; after idle frames, the DOM no longer contains `tab:900`, but `#state-count` was computed from the sparse sidebar-local state instead of the background-owned projection metadata.
- Fix: partial search pruning now preserves authoritative background projection totals while scheduling a remote search refresh.

### PT-009 missing coverage snapshot stays readonly after full hydration

- Status: fixed
- Found by: `psh-coverage-missing-snapshot-restores-actions-after-full-hydration`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-coverage-missing-snapshot-restores-actions-after-full-hydration" --reporter=list --workers=1
```

- Expected: a sparse initial snapshot without coverage metadata should keep actions readonly while full hydration is pending, then restore normal visible-row actions once full `getState` hydration resolves.
- Actual before fix: after full hydration resolved and the row was hovered again, the visible row still had no `Close` action.
- Evidence: the frozen Playwright scenario loads a sparse snapshot with `includeCoverage: false`, verifies `tab:799` has no `Close` action while partial, resolves full state, waits idle frames, hovers `tab:799` again, and previously timed out waiting for the `Close` button.
- Fix: missing coverage metadata now schedules full hydration on the first coverage-dependent hover, so full-state actions can recover without forcing startup scroll-away hydration.

### PT-010 rejected show-in-tree target leaves stale search chrome

- Status: fixed
- Found by: `psh-show-in-tree-rejected-target-response-restores-cleared-outline`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-rejected-target-response-restores-cleared-outline" --reporter=list --workers=1
```

- Expected: after clicking `Show in tree`, the search input is cleared. If the target-node projection request rejects, the sidebar should restore or keep a non-search outline projection with normal outline chrome.
- Actual before fix: the search input was empty, but the sidebar still displayed stale search-result chrome: `1 match / 1001 items`.
- Evidence: the frozen Playwright scenario searches for `Tab 900`, resolves that search result, clicks `Show in tree`, rejects the pending target-node slice, waits idle frames, and previously observed empty `#search` with search-result count text instead of `1001 items / 0 saved`.
- Fix: rejected target-node projection requests restore the last accepted outline projection when the current user intent is cleared search.

### PT-011 rejected clear-search slice leaves stale search chrome

- Status: fixed
- Found by: `psh-clear-search-rejected-response-restores-outline-chrome`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-clear-search-rejected-response-restores-outline-chrome" --reporter=list --workers=1
```

- Expected: after clearing search, if the non-search projection slice rejects, the sidebar should still restore or keep non-search outline chrome matching the cleared search input.
- Actual before fix: the search input was empty, but the sidebar still displayed stale search-result chrome: `1 match / 1001 items`.
- Evidence: the frozen Playwright scenario searches for `Tab 900`, resolves that search result, clicks clear search, rejects the pending non-search projection slice, waits idle frames, and previously observed empty `#search` with search-result count text instead of `1001 items / 0 saved`.
- Fix: rejected cleared-search projection requests restore the last accepted outline projection instead of leaving stale search chrome attached to the cleared input.

### PT-012 visible sparse delete exposes unpainted viewport tail

- Status: fixed
- Found by: manual QA, frozen as `psh-visible-sparse-delete-refills-exposed-viewport-without-scroll`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-visible-sparse-delete-refills-exposed-viewport-without-scroll" --reporter=list --workers=1
```

- Expected: deleting visible nodes from a sparse projection should remove those rows and refill the exposed viewport from background projection state without requiring another scroll event.
- Actual before fix: the compact delete patch removed the rows that were in the local sparse slice, but the newly exposed part of the viewport stayed blank until the user nudged the scroll position.
- Evidence: the frozen Playwright scenario scrolls to row `250`, resolves a narrow sparse slice for rows `250..277`, deletes all those visible tab nodes, and waits for a second projection slice. Before the fix, no refill request arrived; after the fix, `tab:278` becomes visible without another scroll.
- Fix: tree-structure patches now invalidate stale sparse window requests and force a current-viewport refill after local patching, but only for the current user query. Successful show-in-tree slices that no longer contain their requested target are treated as stale and restore the last outline projection.

### PT-013 covered sparse edit controls disappeared

- Status: fixed
- Found by: manual QA, frozen as `psh-move-to-top-level-remains-available-while-partial`, `psh-cut-covered-row-marks-sparse-row-while-partial`, and `psh-keyboard-cut-works-and-paste-waits-while-partial`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-(move-to-top-level-remains-available|cut-covered-row-marks|keyboard-cut-works)" --reporter=list --workers=1
```

- Expected: covered sparse rows should still expose edit actions that can safely begin from the row itself, especially `Cut` and `Move to top level`.
- Actual before fix: the hydrating sparse action gate hid `Cut`, `Paste`, and `Move to top level`; manual QA noticed the send-to-root and cut buttons were gone.
- Evidence: the frozen Playwright scenarios hover covered row `tab:800` while full hydration is pending. Before the fix, the `Move to top level` and `Cut` buttons were absent, and keyboard cut did not mark the row.
- Fix: the sparse action gate now hides only placement-dependent `Paste` while partial. `Cut` is available for editable covered rows, marks the sparse row locally, and starts full hydration so paste/drag placement can recover with whole-tree state. `Move to top level` is available because the background can execute it by node id against authoritative state.

### PT-014 stale scroll slice can render under a newer active search query

- Status: fixed
- Found by: `psh-undo-stale-scroll-response-after-search-keeps-query`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-undo-stale-scroll-response-after-search-keeps-query" --reporter=list --workers=1
```

- Expected: after the user starts a search while an older non-search scroll slice is pending, that stale scroll response must not paint normal outline rows under the active search query.
- Actual: the search input remains `Tab 900`, but the stale non-search scroll slice can make `tab:250` visible.
- Evidence: the frozen Playwright scenario scrolls to row `250`, starts a keyboard undo, types `Tab 900`, then resolves the older scroll slice before the search slice. The DOM shows the current search query and a normal scroll row at the same time.
- Fix: sparse slice rendering now requires the captured request intent and returned snapshot query to still match the current search, outline, or show-in-tree intent. The stale non-search response can merge safe node data, but it cannot paint normal outline rows while a search is active.

### PT-015 temporal undo/search-clear stale ordering can leave cleared outline viewport empty

- Status: fixed
- Found by: `psh-temporal-heat-undo-scroll-search-clear-stale-order`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-temporal-heat-undo-scroll-search-clear-stale-order" --reporter=list --workers=1
```

- Expected: after undo, sparse scroll, search, clear-search, stale response, and a compact background patch interleave, the cleared normal outline should stay painted without requiring another scroll.
- Actual: the search input is cleared and the count returns to normal outline chrome, but the viewport can remain empty.
- Evidence: the frozen Playwright scenario resolves the search response, clears search, emits a background title patch, resolves stale and current sparse responses in conflicting order, and observes `visibleRows.length === 0`.
- Fix: clear-search now invalidates stale sparse admissions, accepts only current outline-intent responses, and requests the current outline viewport instead of row zero so the cleared outline remains painted without needing another scroll.

### PT-016 rejected newer search can leave an older search projection under the current query

- Status: fixed
- Found by: `psh-target-response-after-rejected-new-query-does-not-reveal-stale-target`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-target-response-after-rejected-new-query-does-not-reveal-stale-target" --reporter=list --workers=1
```

- Expected: after a newer search request is rejected, older target/search responses must not leave stale search results visible under the current query. The sidebar should keep the current `Tab 91` intent and fall back to non-search outline chrome or another current-intent recovery state.
- Actual: the search input remains `Tab 91`, but the count and visible row still describe the older `Tab 900` search projection.
- Evidence: the frozen scenario resolves search `Tab 900`, starts show-in-tree for `tab:900`, starts search `Tab 91`, rejects the `Tab 91` slice, then resolves the older target response. Playwright observes `Tab 91` in the search input with `1 match / 1001 items` and visible `tab:900`.
- Fix: rejected current search recovery now restores only the last accepted outline projection while preserving the current search owner, and stale target/search responses are barred from visible ownership when their captured owner no longer matches the current query/target intent.

### PT-017 show-in-tree target reveal can lose its target after background refill

- Status: fixed
- Found by: `psh-show-in-tree-hover-controls-survive-background-refill`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-hover-controls-survive-background-refill" --reporter=list --workers=1
```

- Expected: after show-in-tree reveals `tab:900`, unrelated background deletes/refills near the revealed row should keep `tab:900` visible, preserve the reveal highlight, and leave hover actions usable.
- Actual: after deleting nearby rows `tab:901` through `tab:928`, the rendered viewport falls back toward the earlier active slice and no longer contains the revealed target.
- Evidence: the frozen scenario searches `Tab 900`, clicks `Show in tree`, accepts the target slice, verifies the reveal highlight and action buttons, then emits a background delete/refill. Playwright observes normal outline chrome with visible rows around `754`/`787` instead of the revealed `tab:900`.
- Fix: accepted show-in-tree slices now promote the revealed node to an active reveal target that survives compatible background refills. State-change refreshes reload that target slice instead of falling back to the active-tab outline window, and active-tab recentering is suppressed while target intent owns the projection.

### PT-018 stale target response can restore old search chrome after clear-search

- Status: fixed
- Found by: `psh-show-in-tree-stale-target-after-search-clear-keeps-outline`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-stale-target-after-search-clear-keeps-outline" --reporter=list --workers=1
```

- Expected: after the user replaces a pending show-in-tree target with a new search and then clears search, late target/search responses must not restore search chrome or old match rows under the empty search box.
- Actual: the search input is empty, but after the stale target response resolves the state count shows `1 match / 1001 items` from the older `Tab 900` search.
- Evidence: the frozen scenario searches `Tab 900`, starts show-in-tree for `tab:900`, starts search `Tab 91`, clicks clear-search, then resolves the older target response before the stale search and current outline responses. Playwright observes an empty search input with stale search count text.
- Fix: clear-search bumps the visible owner back to outline and restores only the last accepted outline projection. Target-centered show-in-tree slices are no longer remembered as outline fallback, so stale target/search completions cannot restore old search chrome under an empty search box.

### PT-019 target projection without coverage can expose edit actions while hydrating

- Status: fixed
- Found by: `psh-show-in-tree-missing-coverage-restores-actions-after-hydration`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-missing-coverage-restores-actions-after-hydration" --reporter=list --workers=1
```

- Expected: while full hydration is pending, sparse target projections without coverage metadata should stay read-only; edit actions may appear only after the full state resolves.
- Actual: after show-in-tree accepts a target projection that omits coverage, the target row exposes `Cut`, `Move to top level`, and `Close` before full hydration completes.
- Evidence: the frozen scenario loads an initial sparse snapshot with coverage omitted, searches `Tab 900`, starts show-in-tree, resolves the target slice without coverage, and hovers the revealed row. Playwright finds the `Cut` button before `resolveFullState()` runs.
- Fix: owner-changing projection snapshots replace coverage instead of inheriting coverage from the previous projection. DOM reconciliation now preserves an existing hover action strip only when current sparse coverage proves every preserved action is still admissible; missing coverage keeps the row readonly until full hydration resolves.

### PT-020 undo/history ordering can strand a pending scroll intent on the old slice

- Status: fixed
- Found by: `psh-temporal-two-sidebars-search-scroll-undo-patch-keeps-intents`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-temporal-two-sidebars-search-scroll-undo-patch-keeps-intents" --reporter=list --workers=1
```

- Expected: when a sidebar has pending scroll slices and the user triggers undo while another sidebar has a pending search, later current/covering scroll responses should still paint the requested scroll viewport.
- Actual: after undo/history status and a shared title patch interleave, resolving the covering scroll slice leaves the scrolled sidebar on the old active-window slice around `787` instead of the requested row `260`.
- Evidence: the frozen scenario opens two sidebars, starts search `Tab 91` in one, starts two pending normal scroll requests around `250`/`260` in the other, clicks `Undo` in the scrolled sidebar, fans out history status plus a title patch, then resolves the covering scroll response. Playwright observes the search sidebar intact, but the scrolled sidebar still lacks row `260`.
- Fix: sparse scroll requests capture the current owner and can still render after state changes when they match that owner and cover/intersect the current viewport. Sparse scroll intent also suppresses active-tab recentering, so history/broadcast refreshes do not strand the user on the old active slice.

### PT-021 background patch during pending sparse scroll can strand scroll intent

- Status: fixed
- Found by: `psh-two-sidebars-independent-scrolls-ignore-stale-cross-slices`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-two-sidebars-independent-scrolls-ignore-stale-cross-slices" --reporter=list --workers=1
```

- Expected: two sidebars with independent normal-outline sparse scroll intents should keep those intents when a shared background title patch arrives while one sidebar's scroll slice is still pending. Resolving the covering slice for `tab:900` should paint row `900`, without any full `getState` hydration.
- Actual: the patched sidebar stays on the old active-window slice after the covering `880..940` response resolves, so `tab:900` remains absent.
- Evidence: the frozen scenario scrolls one sidebar to `260` and the second to `900`, emits a shared title patch for `tab:900`, resolves a stale/non-covering slice in the first sidebar and a covering slice in the second. Playwright observes the first sidebar recovered to `260`, but the second sidebar still lacks row `900`.
- Fix: sparse owner state is sidebar-local, so shared background patches do not collapse independent scroll owners. Older same-owner covering/intersecting slices may paint after a patch; stale non-covering slices only merge safe node data and prompt a current-owner viewport refill.

### PT-022 moved show-in-tree target can be highlighted without scrolling into view

- Status: fixed
- Found by: `psh-show-in-tree-target-moved-before-slice-keeps-reveal-current`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-target-moved-before-slice-keeps-reveal-current" --reporter=list --workers=1
```

- Expected: if a show-in-tree target moves before its target-node projection response resolves, the accepted current target response should scroll to and reveal the moved target row.
- Actual: the row receives reveal ownership/highlight, but the visible viewport remains near the previous top rows and does not include the moved target row.
- Evidence: the frozen scenario searches `Tab 900`, clicks `Show in tree`, moves `tab:900` under `window:1` at row `120`, then resolves the current target slice. Playwright observes cleared search and outline chrome with the reveal highlight set, but `visibleRows` does not contain row `120`.

### PT-023 rejected show-in-tree response after target delete restores stale outline count

- Status: fixed
- Found by: `psh-show-in-tree-deleted-target-rejected-response-restores-outline`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-show-in-tree-deleted-target-rejected-response-restores-outline" --reporter=list --workers=1
```

- Expected: if the target node is deleted while its show-in-tree target slice is pending, and that target response then rejects, the sidebar should restore the current outline owner with the deleted node absent and the outline total reduced.
- Actual: the deleted row is gone and reveal state is cleared, but the outline count is restored from stale fallback metadata as `1001 items / 0 saved` instead of `1000 items / 0 saved`.
- Evidence: the frozen scenario searches `Tab 900`, clicks `Show in tree`, emits a compact delete patch for `tab:900`, then rejects the pending target slice. Playwright observes no `tab:900`, no reveal highlight, no full `getState`, and stale outline chrome/count text.

### PT-024 visible sparse delete/refill can leave stale outline count metadata

- Status: fixed
- Found by: `psh-visible-delete-stale-scroll-response-refills-current-window`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-visible-delete-stale-scroll-response-refills-current-window" --reporter=list --workers=1
```

- Expected: after compact delete removes visible sparse outline rows and a current-viewport refill paints the exposed rows, outline chrome should reflect the reduced total row count.
- Actual: the deleted rows are absent and the viewport is refilled, but the count text remains `1001 items / 0 saved` instead of `973 items / 0 saved`.
- Evidence: the frozen scenario paints rows `250..277`, creates a pending stale scroll response, deletes those 28 visible rows, resolves the stale response, then resolves the current refill. Playwright observes `tab:278` visible and no deleted `tab:250`, but stale outline count metadata remains.

### PT-025 move patch for matching search row can fall back to partial search count

- Status: fixed
- Found by: `psh-two-sidebars-move-patch-preserves-search-and-scroll-owners`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-two-sidebars-move-patch-preserves-search-and-scroll-owners" --reporter=list --workers=1
```

- Expected: when a compact move patch reorders a node that is also a current search result, the search owner should keep background-owned search metadata while preserving the matching row.
- Actual: the moved search result stays visible, but search chrome falls back to partial sidebar-local totals: `1 match / 82 items` instead of `1 match / 1001 items`.
- Evidence: the frozen multi-sidebar scenario searches `Tab 260` in one sidebar, paints row `260` in another, then emits the same move patch in both. The outline sidebar keeps its scrolled owner, but the search sidebar keeps `tab:260` visible with stale partial count metadata and no full `getState`.

### PT-026 rejected search after outline move patch can restore stale moved row

- Status: fixed
- Found by: `psh-rejected-search-after-outline-move-patch-keeps-scroll-owner`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-rejected-search-after-outline-move-patch-keeps-scroll-owner" --reporter=list --workers=1
```

- Expected: when an outline row is moved while a search request is pending, and that search request rejects, the sidebar should keep the outline scroll owner but not resurrect the moved row at its old viewport position.
- Actual: the rejected search restores outline chrome and the scrolled viewport, but the moved `tab:260` remains visible in the old sparse window after it was moved to row `900`.
- Evidence: the frozen scenario paints rows around `250`, starts a search for `Tab 260`, emits a move patch relocating `tab:260` under `window:1` near row `900`, rejects the pending search slice, and observes `tab:260` still rendered in the old viewport with no full `getState`.

### PT-027 title patch can be lost behind an older missing-coverage search response

- Status: fixed
- Found by: `psh-search-missing-coverage-title-patch-restores-actions-after-hydration`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-search-missing-coverage-title-patch-restores-actions-after-hydration" --reporter=list --workers=1
```

- Expected: if a compact title patch arrives after a search projection response is resolved but before the sidebar has admitted/rendered it, the later patch should remain visible and the missing-coverage row should stay readonly until full hydration restores edit actions.
- Actual: the search result row remains visible under the current query, but it renders the older title from the sparse response instead of the later patched title.
- Evidence: the frozen scenario starts search `Tab 900`, resolves that sparse search response without coverage, immediately emits a `nodeStateUpdated` title patch for `tab:900`, and waits idle frames. Playwright observes the row still titled `Tab 900` instead of `Tab 900 search coverage patched`, with no full `getState`.

### PT-028 search projection without coverage can expose edit actions while hydrating

- Status: fixed
- Found by: `psh-search-missing-coverage-full-broadcast-restores-actions`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-search-missing-coverage-full-broadcast-restores-actions" --reporter=list --workers=1
```

- Expected: while full hydration is pending, a search projection that omits coverage metadata should render its rows readonly until a full-state broadcast or full hydration proves editability.
- Actual: the search result row immediately exposes `Cut`, `Move to top level`, and `Close` despite the accepted projection snapshot having no coverage metadata.
- Evidence: the frozen scenario starts search `Tab 900`, resolves the search projection with `includeCoverage: false`, hovers the visible search result before any full `getState` or full `stateUpdated` broadcast, and Playwright finds the `Cut` button present.

### PT-029 clear-search after covered title patch can restore outline chrome with an empty viewport

- Status: fixed
- Found by: `psh-clear-search-after-covered-title-patch-keeps-outline-window`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-clear-search-after-covered-title-patch-keeps-outline-window" --reporter=list --workers=1
```

- Expected: after a visible outline window receives a compact title patch, the user searches and then clears search, the sidebar should restore the current outline owner with the same covered window painted.
- Actual: the search input is empty and outline chrome/counts return, but the viewport has no visible rows until another refill/scroll occurs.
- Evidence: the frozen scenario scrolls to rows around `250`, resolves covered outline rows, patches `tab:260`, searches `Tab 900`, clears search, and resolves outline refill requests. Playwright observes `1001 items / 0 saved`, no reveal highlight, no full `getState`, but `visibleRows` is `[]`.

### PT-030 clear-search after title-patched search can leave stale search chrome

- Status: fixed
- Found by: `psh-two-sidebars-title-patch-clear-search-preserves-other-scroll`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-two-sidebars-title-patch-clear-search-preserves-other-scroll" --reporter=list --workers=1
```

- Expected: when a sidebar has a current search projection, receives a compact title patch for that search result, and the user clears search, the sidebar should return to normal outline chrome while other sidebars keep their independent scroll owners.
- Actual: the clearing sidebar's search input is empty, but its count text remains `1 match / 1001 items`.
- Evidence: the frozen multi-sidebar scenario searches `Tab 900` in sidebar A, scrolls sidebar B around row `250`, patches `tab:260` in B and `tab:900` in A, then clears A's search. Sidebar B remains on its scrolled owner, but sidebar A reports stale search count chrome under an empty search input with no full `getState`.

### PT-031 covered sparse drag/drop blocked by full-hydration guard

- Status: fixed
- Found by: manual QA, frozen as `psh-covered-sparse-drag-drop-sends-command-before-hydration`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-covered-sparse-drag-drop-sends-command-before-hydration" --reporter=list --workers=1
```

- Expected: covered visible sparse rows can drag/drop locally and send the background `moveNode` command without full hydration; missing coverage requests a sparse refill and still avoids `getState`.
- Actual: rows were marked draggable, but `dragstart`, `dragover`, `drop`, and root drop handlers returned while `hydratingFullState` was true, so sparse-by-default sidebars effectively lost drag/drop.
- Evidence: the frozen scenarios cover row-to-row drag/drop, root drag/drop, and missing-coverage drag/drop before full hydration. The fixed path sends `moveNode`/`moveNodeToNewWindow` for covered placements, keeps `stateRequestCount()` at `0`, and requests `getTreeProjectionSlice` when coverage is absent.

### PT-032 rename interaction can strand active search on outline rows

- Status: retracted
- Found by: `psh-rename-blur-search-replacement-keeps-query-owner`, `psh-rename-escape-search-replacement-keeps-query-owner`, and `psh-rename-enter-then-search-keeps-query-owner`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-(rename-blur-search-replacement-keeps-query-owner|rename-escape-search-replacement-keeps-query-owner|rename-enter-then-search-keeps-query-owner)" --reporter=list --workers=1
```

- Expected: after a sparse sidebar enters rename mode and then the user searches, the current search owner should win whether rename was canceled, explicitly committed, or committed by blur; `#search = "Tab 900"` should render the `Tab 900` search result and search count chrome without full hydration.
- Original suspicion: the visible projection remained normal outline rows and the count stayed `1001 items / 0 saved` while the search input contained `Tab 900`.
- Retraction: the failing repro was resolving an older outline refill request created when the test scrolled to the window row to start rename, then it never resolved the later debounced search request. The corrected scenarios deliberately resolve that stale outline slice first, wait for the `Tab 900` search request, resolve it, and pass without product changes. The coverage remains useful because it proves rename blur, Escape cancel, and Enter commit do not block current search ownership once the current search response arrives.

### PT-033 delayed closed-restore scope can prompt after target deletion

- Status: fixed
- Found by: `psh-restore-scope-response-after-delete-does-not-prompt-stale-restore`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-restore-scope-response-after-delete-does-not-prompt-stale-restore" --reporter=list --workers=1
```

- Expected: if the closed restore target is deleted before a delayed `analyzeRestoreScope` response resolves, that stale scope response should not prompt the user or send a restore for the removed subtree.
- Actual before fix: after the compact delete patch removes `window:30` and its closed children, resolving the old scope response still opens the large-restore confirmation dialog for the deleted subtree.
- Evidence: the frozen scenario delays `analyzeRestoreScope`, clicks `Restore Closed Window`, emits history status plus a `treeStructureUpdated` delete patch for `window:30`, `tab:30`, `tab:31`, and `tab:32`, then resolves the old scope response. Playwright observes the confirmation dialog text `Restore 4 restorable closed nodes...`; the row shell is already absent and no full `getState` occurs.
- Fix: restore-scope results are checked against current sidebar state after the async scope request and again after any confirmation prompt. Stale scope responses are dropped if the target no longer exists, is no longer closed, or known scoped rows no longer remain closed.

### PT-034 pending target reveal can be lost by history/title patch before target response

- Status: fixed
- Found by: `psh-two-sidebars-keyboard-undo-and-target-stale-scroll-stay-independent`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-two-sidebars-keyboard-undo-and-target-stale-scroll-stay-independent" --reporter=list --workers=1
```

- Expected: when one sidebar has a current show-in-tree target request pending, a concurrent history-status/title patch should not demote that target owner; resolving the target slice should reveal `tab:900` with the search box cleared.
- Actual before fix: after the history/title patch arrives before the target slice resolves, the target response does not paint row `900`; the sidebar falls back to normal outline rows around the previous sparse window.
- Evidence: the frozen multi-sidebar scenario keeps sidebar A on a pending sparse scroll plus keyboard undo, while sidebar B searches `Tab 900`, starts `Show in tree`, receives a history status and title patch for `tab:900`, then resolves the pending target slice. Sidebar B times out waiting for visible row `900`, with outline chrome and rows around `760..800` instead of the reveal target.
- Fix: state-change refresh now preserves pending show-in-tree ownership. While `pendingShowInTreeNodeId` is set, compact patches do not start a generic outline refill that can race ahead of the current target response.

### PT-035 delayed closed-restore scope can prompt after scoped child deletion

- Status: fixed
- Found by: `psh-delayed-restore-scope-child-delete-invalidates-prompt`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-delayed-restore-scope-child-delete-invalidates-prompt" --reporter=list --workers=1
```

- Expected: if one closed child in a delayed closed-window restore scope is deleted before `analyzeRestoreScope` resolves, the stale scope response should not prompt with the old subtree count or send a restore command for the outdated scope.
- Actual before fix: after deleting `tab:30`, the sidebar updates the visible closed count to `3 items / 3 saved`, but resolving the old scope still opens the confirmation dialog for `4 restorable closed nodes (3 tabs, 1 window)`.
- Evidence: the frozen scenario delays `analyzeRestoreScope`, clicks `Restore Closed Window`, emits history status plus a `treeStructureUpdated` delete patch for only `tab:30`, then resolves the old scope response. Playwright observes the stale large-restore confirmation prompt while `tab:30` is already absent, `window:30` remains visible, and no full `getState` occurs.
- Fix: restore-scope validity now snapshots the node ids locally known before the async scope request. Missing scoped nodes that were never present in the sparse sidebar can remain unknown, but a scoped node that was known at request time and is later deleted or changed away from `closed` invalidates the delayed scope response.

### PT-036 collapsed-parent missing child-order coverage does not request recovery

- Status: open
- Found by: `psh-collapsed-parent-inside-drop-missing-child-order-refills`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-collapsed-parent-inside-drop-missing-child-order-refills" --reporter=list --workers=1
```

- Expected: when a sparse sidebar knows a visible collapsed parent but lacks coverage proving that parent's hidden child order, dropping a covered visible row inside that collapsed parent should be blocked, clear preview state, avoid full `getState`, and request a background projection/coverage refill for the current outline intent.
- Actual: the drop is blocked and no command is sent, but no `getTreeProjectionSlice` request is made either. The user has no recovery path from the attempted local drop unless another interaction happens to request coverage.
- Evidence: the frozen scenario loads a four-row outline with `window:1`, a covered source row, a visible collapsed group whose hidden children are not rendered, and a trailing sibling. Coverage proves only `window:1` sibling order, not `group:collapsed`. Dragging `tab:10` inside `group:collapsed` times out waiting for any sparse projection request; the paired covered-child-order scenario passes and sends `moveNode` with `parentId: "group:collapsed"` and `index: 2`.

### PT-037 collapsed-parent expansion does not request hidden child rows

- Status: open
- Found by: `psh-collapsed-parent-expand-patch-refills-hidden-children`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-collapsed-parent-expand-patch-refills-hidden-children" --reporter=list --workers=1
```

- Expected: when a sparse sidebar has a collapsed parent whose child nodes are absent locally, expanding that parent and receiving a collapsed-state patch should request a current outline projection/coverage refill so the newly visible child rows can be painted without full `getState`.
- Actual: the `toggleCollapsed` command is sent and the collapsed patch is applied locally, but no `getTreeProjectionSlice` request is made. The parent can become expanded while the hidden child rows remain absent.
- Evidence: the frozen scenario loads `window:1 -> tab:10, group:collapsed, tab:90` with `tab:50` and `tab:51` present only in the background fixture. It clicks `Expand`, emits a `nodeStateUpdated` patch setting `group:collapsed.collapsed = false`, then times out waiting for any sparse projection request. The paired `psh-collapsed-parent-collapse-patch-hides-loaded-children` scenario starts with those children loaded and verifies collapse hides them locally without full hydration.
