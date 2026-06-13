# `sidebar.ts` map (UI decomposition)

Status: analysis only (2026-06-13). No code changes. Purpose: make the 5,627-line
`src/sidebar/sidebar.ts` navigable and lay out a *safe* decomposition order, mirroring what
[docs/controller-factory-map.md](controller-factory-map.md) did for the background factory.
Rationale + the proven strangler loop live in [[controller-decomposition]] (memory).

**Line numbers drift — search by symbol name.** They are as of this writing.

## 0. The shape of the fear — and why it differs from controller.ts

`controller.ts` was one giant `createBackgroundController` **factory closure**; its bus was ~70
closure-scoped `let`s. `sidebar.ts` is a **module**: there is no factory. Execution begins at a band
of **top-level statements (`:410–502`)** — the bootstrap — that runs once when the module loads:

```
installProfileConsole(); applyZoom(currentZoom);
registerPreferenceListener(); registerZoomShortcuts(); registerSearchControls();
registerToolbarOverflowControls(); registerPortableTreeControls(); registerHistoryControls();
registerTreeControls(); registerVirtualViewport(); updateHydrationControls();
void loadZoomPreference(); void loadSidebarPreferences(); void loadState(); void loadHistoryStatus();
…DOM listeners on refresh/openOptions/openSidebarWindow/rootDropSurface…
const backgroundPort = connectToBackgroundPort();  // + onMessage → handleBackgroundMessage
browser.runtime.onMessage.addListener(handleBackgroundMessage);
```

So the UI is an **event-driven state machine with two ingress points** — exactly like the
controller, but the events are DOM input + a runtime port instead of `handleMessage`:

1. **`handleBackgroundMessage` (`:512`)** — the message router. A clean guard-ladder
   (`isStateUpdated` → `setCurrentState`+`render`, `isNodeStateUpdated` → `applyNodeStateUpdate`, …).
2. **DOM event listeners** registered by the eight `register*()` functions + the bootstrap band.

**The bus is the module-level mutable state at `:108–190`** — ~45 `let` bindings plus a few
`const` collections (`deletedNodeRevisionById`, `renderedProjectionSession`) and the **17 cached DOM
handles at `:90–106`** (`tree`, `empty`, `searchInput`, `undoHistory`, …). Nothing lifts out until
ownership of the slice it touches is assigned. Everything below makes that assignment possible.

The DOM handles are a second, sidebar-specific coupling the controller never had: ~17 elements
grabbed once via `document.querySelector` and closed over by dozens of functions. A lifted module
must take the handles it needs as deps (or query them itself).

## 1. Mutable state — clusters (~45 `let` + key `const` collections)

Ranked by entanglement (how many functions touch it):

| Cluster | Key bindings | Entanglement | Decl |
|---|---|---|---|
| **Canonical state + projection** (the core) | `currentState` (read ~everywhere), `currentStateFullyLoaded`, `hydratingFullState`/`fullStateHydrationInFlight`/`pendingFullHydrationTimer`, `currentProjection`, `currentProjectionCoverage`, `projectionState`, `projectionQuery`, `currentProjectionOwner`/`projectionOwnerRevision`, `renderedProjectionSession`, `scheduledVirtualRender`, `preserveRenderedRowWindowOnce`, `suppressActiveScrollOnce` | **Highest.** Live truth + what's painted. `render()`/`renderVirtualRows()`/all `apply*Update` read & write it. | :108–190 |
| **DOM handles** | `tree`, `empty`, `searchInput`, `clearSearch`, `stateCount`, `diagnostics`, `undo/redoHistory`, `refresh`, `toolbarOverflow(+Menu)`, `openOptions`, `export/importTree(+File)`, `openSidebarWindow`, `rootDropSurface`; created: `dropMarker`, `dropGuideLayer` | **High fan-in, zero logic.** The shared element bus. | :90–106, 388–396 |
| **Sparse / remote projection requests** | `sparseWindowRequestSequence`, `sparseWindowStateChangeCutoff`, `pendingSparseWindowRequest`, `currentProjectionOwner`, `remoteSearchRequestSequence`, `pendingRemoteSearchTimer` | High; the request-orchestration slice. Coupled to projection core. | :151–156, 153–190 |
| **Hover guide overlay** | `hoverLineScope`, `pendingHoverLineScope`, `pendingHoverGuideApply`, `pendingHoverGuideReason`, `pendingHoverFeedbackTrace`, `scheduledHoverGuideFrame` | A self-contained 6-var state machine. Reads `currentProjection` + rendered rows; writes only its own vars + row CSS classes. **Disjoint slice.** | :131–136 |
| **Drag-drop** | `draggedNodeId`, `activeDropPlacement` + DOM `dropMarker`/`dropGuideLayer` | Cohesive theme, but reads core state/projection + sends commands. | :115–116 |
| **Zoom** | `currentZoom`, `wheelZoomDelta` | Small, self-contained; pure logic already in `zoom.ts`. Writes CSS vars to `:root`. **Disjoint slice.** | :117,119 |
| **Search** | `currentSearchQuery` (+ the two remote-search vars above) | Coupled to projection (query drives projection). | :120 |
| **Diagnostics notice** | `diagnosticsNoticeUntil`, `diagnosticsNoticeTimer` + `diagnosticsScheduler` singleton | Small; owns the `#diagnostics` element message + reload schedule. **Disjoint slice.** | :121–122, 398 |
| **Rename session** | `activeRename` | One var; coupled to `tree` DOM + commands. | :123 |
| **Cut/paste** | `pendingCutNodeId`, `currentCutRowRange` | Pure logic already in `cut-paste.ts`; residue is state + row marking. | :140–141 |
| **Show-in-tree / reveal** | `pendingShowInTreeNodeId`, `activeRevealTargetNodeId`, `revealHighlightNodeId`, `revealHighlightTimer` | Coupled to scroll/projection. | :142–145 |
| **Sidebar window identity + active-tab targets** | `sidebarWindowId`, `sidebarWindowIdLoaded`, `sidebarActiveTabTargets{Revision,CacheRevision,ByWindow}` + `activeTabScrollTracker` singleton | A memoized lookup cache; coupled to active scroll. | :146–150, 166 |
| **Interaction timing** | `lastNonEditInteractionAt`, `lastNonEditInteractionBroadcastAt`, `lastSparseViewportScrollIntentAt` | Cross-cutting debounce signals consumed by diagnostics + hydration + sparse scroll. | :137–139 |
| **Preferences** | `appPreferences` | Leaf. | :118 |
| **Perf/profile** | `perfTrace` singleton, `sidebarProfileInstanceId` | Leaf; debug console + tracing. | :212, 406 |

The core (canonical state + projection) is advanced through `setCurrentState` (`:216`), `render`
(`:2206`), `renderVirtualRows` (`:3310`), and the four `apply*Update` patch appliers (`:2668–3060`).
Those compose every other sub-system and mutate the painted truth — the **irreducible heart**, the
analog of the controller's state-triad.

## 2. Sub-systems (in order of appearance)

| Sub-system | Span (approx) | Owns | Coupling |
|---|---|---|---|
| Header: imports, DOM handles, module state, local types, constants | :1–214 | *all* state | The bus. |
| Deleted-node tracking + snapshot helpers (`setCurrentState`, `record*`, `*ContainsNodeDeletedAfter`, `nodeIdsInProjectionSnapshot`) | :216–270 | `deletedNodeRevisionById`, `sidebarMutationRevision` | Feeds restore-scope staleness checks. |
| Singleton setup (`dropMarker`, `dropGuideLayer`, `diagnosticsScheduler`, `perfTrace`) | :388–408 | those singletons | — |
| **Bootstrap** (top-level install/register/load + DOM listeners + port wiring) | :410–502 | — | Phase, runs once. The entry band. |
| Port + **message router** (`connectToBackgroundPort`, `handleBackgroundMessage`) | :504–562 | nothing | Low as a router; dispatches to core. |
| State load / hydration (`loadState`, `hydrateFullState`, `scheduleFullStateHydration`, `applyInitialTreeSnapshot`, `renderInitialTreeSnapshot`) | :564–735 | hydration flags | Seeds core; medium. |
| **Sparse / remote projection request orchestration** (`requestSparseScrollWindowIfNeeded`, `startSparseScrollWindowRequest`, `loadSparseScrollWindow`, `requestProjectionSlice`, request-intent/owner machinery, sparse-coverage + viewport-range predicates) | :735–1233 | sparse/owner/remote-search vars | **High** — "make projection match a remote slice." Largest single sub-system (~500 lines). Near-core. |
| Preference / zoom-load / window-id load + **profile-trace console** | :1235–1407 | `appPreferences`, profile console | Leaf-ish; profile console is debug plumbing. |
| **UI control registration** (`register*` ×8 + toolbar overflow) | :1408–1684 | wires listeners onto DOM handles | High fan-out, runs once. |
| History controls (`loadHistoryStatus`, `runHistoryCommand`, `updateHistoryControls`, keyboard) | :1684–1727 | — | Reads `undo/redoHistory`; sends commands. |
| Export / import tree | :1728–1792 | — | Commands + file IO. |
| **Search** (`clearSearchQuery`, `updateSearchControls`, remote-search projection, partial-search refresh) | :1792–2147 | `currentSearchQuery` + remote-search vars | Coupled to projection + requests. |
| Zoom apply (`setZoom`, `applyZoom`, `saveZoomPreference`, wheel/keyboard intent) | :2148–2205 | `currentZoom`, `wheelZoomDelta` | Self-contained; writes `:root` CSS. |
| **Render orchestration + DOM reconciliation** (`render`, `updateProjectionChrome`, projection clone/merge, `renderSnapshotRows`, `reconcile*`, `syncChildNodes`, `updateHydrationControls`) | :2206–2667 | core projection + `tree`/`empty` DOM | **Core.** The paint pipeline. |
| **Incremental state-update appliers** (`applyActiveStateUpdate`, `applyNodeStateUpdate`, `applyTreeStructureUpdate`, `applySameParentReorderUpdate`, post-patch projection refresh, node-capability predicates) | :2668–3256 | mutate core state + projection | **Core.** |
| **Virtual render** (`visibleProjectionFor`, `scheduleVirtualRender`, `renderVirtualRows`, render-range, coverage gating, `currentRowHeight`) | :3258–3554 | `scheduledVirtualRender` + core | **Core.** Virtualization engine (pairs with `visible-tree.ts`). |
| Row + node-action rendering (`renderRow`, `nodeItemClassName`, `renderNodeActions`, descendant checkers, `appendTitleText`) | :3555–3823 | — | Reads core; builds DOM. Mostly pure-ish builders. |
| **Hover guide / pointer feedback** (`handleTreePointerOver`, `materializeSparseRowActions`, hover-line-scope state machine, guide rendering, input-delay tracing) | :3824–4305 | hover-guide 6-var slice | **Disjoint slice** + ~480 lines. Reads projection/rows, writes own vars + row classes. |
| Click / drag-drop input (`handleTreeClick`, `handleTreeDragStart/Over/Drop`, `canStartDragForNode`, `canUseDropPlacement`, `requestSparseDragDropCoverage`) | :4306–4549 | `draggedNodeId`, `activeDropPlacement` | Reads core/projection; sends commands. |
| Tree input / keyboard / **rename** (`handleTreeInput/Keydown/FocusOut`, rename session) | :4550–4670 | `activeRename` | Coupled to `tree` DOM + commands. |
| Drop placement / preview + DOM lookup helpers (`dropPlacementForRowEvent`, `actionButton`, `iconElement`, `showDropPlacement`, drop preview/marker, `nodeItemForId`, `rowForEventTarget`, `cssEscape`) | :4671–4946 | `dropMarker`/`dropGuideLayer` | Drag-drop DOM; mixed pure + stateful. |
| Active scroll / reveal (`scrollToObservedActiveTab`, active-tab-target compute, `scrollToPendingShowInTreeRow`, reveal highlight, `centerRowInViewport`, `prepareVirtualScrollSurface`) | :4947–5129 | window-id + active-tab-target cache, reveal vars | Coupled to scroll + projection (pairs with `active-scroll.ts`). |
| Drop execution + **restore confirmation** (`performDrop`, `restoreNodeWithConfirmation`, restore-scope helpers) | :5130–5310 | — (reads deleted-node tracking) | `restoreScope*` helpers are mostly pure. |
| Command sending (`runAndRender`, `openFullSizeSidebarWindow`, `sendCommand`, `commandErrorText`, `showLoadError`) | :5311–5374 | — | The egress to background. |
| **Diagnostics** (`showDiagnosticsNotice`, `scheduleDiagnosticsLoad`, `loadDiagnostics`, `diagnosticsText`) | :5375–5451 | diagnostics-notice slice | Self-contained; owns `#diagnostics`. |
| **Message guards + message types** (`messageType`, `is*` predicates, `ActiveStateUpdate`/`TreeStructureUpdate`/`SameParentReorderUpdate`/`NodeStateUpdate` types) | :5452–5627 | nothing | **Pure.** Zero module-state. |

## 3. Decomposition roadmap (smallest / lowest-risk first)

Same strangler loop as the controller (behaviour-preserving; `typecheck:test` + vitest 720/2-skip +
Playwright 279 green; the `*.test.ts` and `*.spec.ts` unmodified). Two extraction shapes:
**(P)** pure helpers → their own module (Track-A style, like `message-guards.ts`); **(F)** a stateful
sub-system → a `createX(deps)` factory owning its slice (like `sidebar-broadcaster.ts`).

1. **(P) Message-type guards** (`:5452–5627`, ~175 lines). Pure predicates + the four update types,
   zero module-state. Mirrors `message-guards.ts` exactly — the cleanest possible first cut, validates
   the loop on this file. Export the moved types, import them back into the appliers. → `sidebar-messages.ts`
2. **(P) Restore-scope helpers** (`:5179–5291`, ~110 lines). `restoreScope*`, `isDescendantOfNode`,
   `isRestoreScope`, prompt/summary builders — take `(state, nodeId)`, return scope/bool/string.
   Leave the stateful `restoreNodeWithConfirmation` orchestrator (`:5136`) in place. Verify the
   deleted-node-staleness coupling (`snapshotContainsNodeDeletedAfter`) before cutting. → `restore-scope.ts`
3. **(F) Diagnostics notice** (`:5375–5451`, ~80 lines). Owns `diagnosticsNoticeUntil`/`Timer` +
   the `diagnosticsScheduler` singleton. Deps: the `#diagnostics`/`#state-count` handles, `sendCommand`,
   `perfTrace`, the interaction-timing getters. Small stateful factory — the SidebarBroadcaster-shaped
   warm-up. → `createDiagnosticsNotice(deps)`
4. **(F) Zoom controller** (`:2148–2205` + `loadZoomPreference :1235` + `registerZoomShortcuts :1408`
   + `saveZoomPreference`). Owns `currentZoom`/`wheelZoomDelta`. Deps: `:root` element, `browser.storage`,
   a render/repaint trigger, `perfTrace`. Self-contained; pure math already in `zoom.ts`. → `createZoomController(deps)`
5. **(F) Hover guide overlay** (`:3824–4305`, ~480 lines — the biggest single win). Owns the 6-var
   hover slice. Deps: `getCurrentProjection()`, the `tree` element / rendered rows, `perfTrace`,
   `requestAnimationFrame`, `scheduleFullStateHydration`, `noteNonEditInteraction`. A genuine disjoint
   state machine — high value, medium risk. Do it *after* 1–4 prove the loop on UI code. → `createHoverGuide(deps)`

**Candidates to weigh later (own state but wider seams):** the **sparse/remote projection request
orchestrator** (`:735–1233`) — large and cohesive but coupled to the projection core (the analog of
the controller's refresh orchestrator that was left near-core); **profile-trace console** (`:1266–1407`,
debug plumbing); **drag-drop** and **rename** (cohesive themes but read core state + send commands).

**Leave as the irreducible heart:** canonical state + projection, `render`/`renderVirtualRows`, the
four `apply*Update` appliers, and `setCurrentState`. They mutate the painted truth through one
pipeline; "extracting" them is the clean-room rewrite already ruled out ([[reconciliation-state-model-audit]]).

## 4. What this buys

Fear here is "I don't know what this 5.6k-line module holds or what my change ripples into, and the
render path is load-bearing." §1 says what state exists and who touches it (incl. the DOM-handle bus
the controller lacked); §2 names the sub-systems and where they live; §3 says which five lift out
safely (two pure, three small factories), in risk order, and which core stays. The first cut
(`sidebar-messages.ts`) is a ~175-line pure move with the dual test net (vitest + Playwright) as
backstop — the low-risk shape Track A proved repeatedly on the controller.
