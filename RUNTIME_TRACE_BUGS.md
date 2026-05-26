# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic runtime trace hunts.
The current adversarial hunt mode defaults to lower-anchoring discovery traces guided by `RUNTIME_TRACE_HUNT_GUIDE.md`; known RT/SS-derived traces are preserved as regression coverage and explicit replay evidence, not as the default mutation prompt.
The hunt intentionally documents findings before fixes; fix passes update statuses while preserving the original repros.

Fix passes must satisfy both correctness and performance gates before changing a finding to fixed: promoted trace replay and the selected `pnpm perf:runtime-guard` scenarios. Record the selected perf suite, before/after numbers, and any approved budget movement in the relevant fix analysis. Profile-export analysis is optional forensic evidence only when a fresh current-build browser profile exists.

Run the hunt with:

```sh
pnpm trace-hunt:runtime
```

Default hunt bounds:

- Corpus run safety cap: 30 minutes by default (`RUNTIME_TRACE_HUNT_CORPUS_RUN_MS` overrides); the five-minute budget belongs to the external mutation effort block
- Agent stop condition: 3 full 5-minute discovery mutation blocks with no new distinct findings
- Trace selection: default profile is `discovery`; use `RUNTIME_TRACE_HUNT_PROFILE=regression|all` for known repro replay, or `RUNTIME_TRACE_HUNT_TRACE_IDS=...` for explicit trace replay
- Corpus semantics: execute the selected explicit domain trace corpus once, recording every distinct failure; mutate discovery domain actions between runs instead of perturbing seeds
- Test target: `src/background/controller.test.ts`
- Test name: `adversarial runtime domain traces`
- Trace filter: `RUNTIME_TRACE_HUNT_TRACE_IDS=rt-active-race,rt-stale-updated-after-move`

## Last Domain Run

- Completed: 2026-05-25T18:49:55Z
- Strategy: Mixed-provenance window cohabitation sweep with neutral `yh-*` traces, Rung 1 architecture mutations, and Rung 2 high-temperature mixes
- Trace ids: current discovery corpus in `src/background/controller.test.ts` and `scripts/hunt-runtime-traces.mjs`
- Corpus size after latest corpus edit: 800 discovery traces, 251 regression traces
- Distinct findings recorded: none.
- Stop condition: reached after three full active mixed-provenance mutation blocks found no new distinct signatures; discovery runs covered 785, 793, then 800 traces.
- Regression safety replay after the hunt: 251 regression traces, 0 failures, 0 new findings at 2026-05-25T18:48:56Z.
- Status: no open runtime findings.

## Finding Index

- Open recorded findings: none
- Fixed subagent-orchestrated sweep finding: RT-219; duplicate evidence RT-220 and RT-221 cover the same root fix
- Fixed cross-axis findings: RT-217 through RT-218
- Fixed/triaged fullscreen window-state findings: RT-214 through RT-216
- Fixed shape-fresh runtime fact findings: RT-205 through RT-213
- Fixed window-scope session-only close findings: RT-199 through RT-204
- Fixed/triaged browser-created closed-state findings: RT-187 through RT-198
- Fixed user-reported runtime findings: UR-001
- Fixed runtime-shape integrity findings: RT-171 through RT-186
- Fixed browser-authored drift findings: RT-155 through RT-170
- Fixed lifecycle-journal crash findings: RT-128 through RT-154
- Fixed history-boundary findings: RT-106 through RT-127
- Fixed transaction-boundary findings: RT-104 through RT-105
- Fixed/triaged post-recovery lifecycle findings: RT-096 through RT-103
- Fixed breadth discovery findings: RT-091 through RT-095
- Fixed reconciliation architecture stress findings: RT-063 through RT-090
- Fixed coverage-first discovery findings: RT-040 through RT-062
- Fixed lower-priming discovery findings: RT-022 through RT-039
- Fixed domain trace adversary findings: RT-009 through RT-021
- Previous adaptive seed-frontier run: RT-001 through RT-008
- Recovered pre-adaptive seed sweep: SS-001 through SS-006

## Current Fixed Hunt Analysis

- Mixed-provenance window cohabitation sweep: added 39 neutral `yh-*` discovery traces covering saved/restored/browser-created/command-created tabs sharing, leaving, closing, and outliving the same runtime windows. Rung 1 shifted into command/restored scope handoff, close/delete journal recovery, window-state transfer, and no-journal restart freshness. Rung 2 combined cohabitation with history replay, partial snapshots, focus in another window, fullscreen/window state, and two mixed-window close/skew cases. Three full corpus runs found no new distinct signatures.
- RT-219 shows a history/journal boundary after two browser-authored drifts: a Tabs Outliner group command is undone, browser-created/native-moved tabs have already changed the runtime shape, then `outlinerRedoThenAbruptRestart` loses live tab `2` from the outline while the browser still has it. The bug is not a stale-metadata/order issue; it is a live-resource preservation failure across history replay plus abrupt restart recovery after browser-authored movement.
- RT-220 and RT-221 are duplicate evidence for RT-219, not separate root causes. They vary the evidence order and destination shape (`manualRefresh` before the redo crash, and saved tab merged into an external window), but hit the same invariant at the same command boundary.
- The fix makes history journal recovery follow the same current-runtime-shape discipline as live history replay: remap materialized windows against the complete startup snapshot, preserve current live resources before and after reconciliation, and delete superseded stale history window subtrees when their runtime window no longer exists and their live tabs have already been recovered under current runtime windows.
- Perf gate for RT-219 through RT-221: `pnpm perf:runtime-guard` passed all 8 scenarios. Key sentinels: close tab-removed-then-session firstBroadcastMs=52 totalWithSaveFlushMs=207 saves=1 broadcasts=1; close session-then-tab-removed firstBroadcastMs=53 totalWithSaveFlushMs=200 saves=1 broadcasts=1; restore transient echo firstBroadcastMs=20 totalWithSaveFlushMs=187 saves=1 broadcasts=1; group-live-leaf firstBroadcastMs=74 totalWithSaveFlushMs=219 saves=1 broadcasts=2; move-leaf firstBroadcastMs=42 totalWithSaveFlushMs=217 saves=1 broadcasts=2; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=114 saves=0 broadcasts=0. No budget movement was accepted for this fix.

## Recent Fixed Hunt Analysis

- RT-217 and RT-218 both showed the same history boundary: a browser-authored tab move changed current runtime window/active shape, then TO history undo replayed an older structural delta and left the outline tab's active flag stale. RT-218 confirmed the issue survived a clean restart between browser move and history replay.
- The fix captures a complete runtime snapshot before history replay can drive browser sync, overlays current runtime `windowId`, `active`, and metadata for surviving live tabs when the old delta would regress browser-authored shape, and then reconciles again after any close/materialize/sync side effects. The overlay deliberately skips delete replay and TO-command-created target/source windows so delete and ordinary structural history commands keep their strict semantics.
- Perf gate for RT-217 through RT-218: `pnpm perf:runtime-guard` passed all 8 scenarios. Key sentinels: close tab-removed-then-session firstBroadcastMs=47 totalWithSaveFlushMs=196 saves=1 broadcasts=1; close session-then-tab-removed firstBroadcastMs=54 totalWithSaveFlushMs=198 saves=1 broadcasts=1; restore transient echo firstBroadcastMs=18 totalWithSaveFlushMs=177 saves=1 broadcasts=1; group-live-leaf firstBroadcastMs=89 totalWithSaveFlushMs=242 saves=1 broadcasts=2; move-leaf firstBroadcastMs=47 totalWithSaveFlushMs=229 saves=1 broadcasts=2; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=139 saves=0 broadcasts=0. No budget movement was accepted for this fix.
- RT-214 and RT-216 were the same close-classification bug with and without fullscreen: after abrupt restart, a browser-created single-tab window could be reconstructed without actionable provenance, so a later `sessionChangedOnly` disappearance deleted the live record instead of preserving it closed. New runtime windows materialized by reconciliation now carry browser-created provenance, reconstructed ledgers restore durable provenance, and missing whole-window session evidence is classified in the reconciler.
- RT-215 was a harness/actionability boundary: the restored live tab was a valid command target, but the domain runner required another same-window tab before it would send `wrapNodeInGroup`. The harness now allows single-tab live targets, and focused coverage confirms restored tabs remain command-addressable after abrupt restart.
- Perf gate for RT-214 through RT-216: `pnpm perf:runtime-guard` passed all 8 scenarios. Key sentinels: close tab-removed-then-session firstBroadcastMs=46 totalWithSaveFlushMs=178 saves=1 broadcasts=1; close session-then-tab-removed firstBroadcastMs=46 totalWithSaveFlushMs=177 saves=1 broadcasts=1; restore transient echo firstBroadcastMs=18 totalWithSaveFlushMs=160 saves=1 broadcasts=1; group-live-leaf firstBroadcastMs=70 totalWithSaveFlushMs=207 saves=1 broadcasts=2; move-leaf firstBroadcastMs=39 totalWithSaveFlushMs=208 saves=1 broadcasts=2; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=116 saves=0 broadcasts=0. No budget movement was accepted for this fix.
- RT-205, RT-206, RT-208, RT-209, and RT-212 showed saved-window scopes accepting stale pre-reorder event-local tab evidence after the browser had already made a newer same-window order/active/metadata change.
- RT-207, RT-210, and RT-213 showed the same stale evidence problem inside command-created destination scopes after a Tabs Outliner relocation plus browser-authored sibling edit.
- RT-211 showed the metadata half of the same problem in a browser-created scope.
- The root was not live-id ownership. The scope index routed the event to the right owner, but the routed fact model was too permissive about raw event-local `created`/`updated` tab snapshots after current same-window shape had changed. The fix separates ownership from freshness with typed tab evidence, field masks, shape-fact generation, and targeted metadata corroboration.

## Fix Analysis

- Active-state relocation race: RT-001, RT-002, RT-009, RT-010, SS-001, and SS-002 were fixed by applying browser-returned command-created window tab data to relocated outline tabs instead of preserving stale pre-command `active` flags.
- Stale old-window relocation echoes: RT-003 through RT-008 and SS-003 through SS-006 were fixed by keeping old-window stale echo protection after fresh current-window events; protection now ends only when the tab/node disappears or a later command updates the tracked destination.
- Empty source/destination windows after command relocation: RT-011, RT-019, RT-020, and RT-021 were fixed by making the fake browser remove windows emptied by tab moves/closes, and by closing/promoting source outline windows when a command relocation moves all owned live tabs into a command-created runtime window.
- Native close ownership: RT-012, RT-013, RT-014, and RT-016 were fixed by treating `windows.onRemoved` as authoritative browser-window close evidence; the outline now preserves the closed window subtree instead of deleting the single removed tab first.
- Delete rejection recovery: RT-015, RT-019, RT-020, and RT-021 were fixed by continuing through every resource in a captured close plan, then recovering model deletion when the runtime resources are already gone despite an adapter rejection.
- Removed relocated-tab resurrection: RT-017 and RT-018 were fixed by limiting session-only missing-window cleanup to command-relocated tabs and by keeping removed/deleted tombstones in stale relocation fallback paths.
- History replay relocation protection: RT-022, RT-023, RT-024, and RT-027 were fixed by making undo/redo transitions register the same command-relocation echo denylist as direct move/group commands.
- History lifecycle expectations: RT-025 was fixed in the trace harness by treating explicit undo/redo as intentional lifecycle commands, so user history can restore command-deleted nodes while stale runtime events still cannot.
- Stale and partial refresh snapshots: RT-026 and RT-028 through RT-039 were fixed by preserving command-relocated tabs from the current outline state when `tabs.query` returns an old-window copy or omits the relocated tab entirely, without recreating tabs whose node or destination window was actually removed.
- Missing whole-window refresh snapshots: RT-040, RT-047, RT-050, RT-051, RT-052, RT-058, and RT-061 were fixed by treating zero-tab snapshots for still-open windows as partial evidence and filling them from current live outline tabs before reconciliation.
- History replay plus partial/stale refresh: RT-041, RT-042, RT-043, RT-056, RT-060, and RT-062 were fixed by clearing removal tombstones when undo/redo rematerializes live resources and by absorbing command-restored tab creation echoes.
- Native close event-order ownership: RT-044, RT-045, RT-046, RT-053, RT-054, and RT-055 were fixed by deriving close semantics from the event shape and browser window existence, preserving closed window subtrees even when only tab removal events arrive.
- Command relocation rejection side effects: RT-048, RT-049, RT-057, and RT-059 were fixed by detecting successful browser-side `createWindow({ tabId })` effects after adapter rejection and applying the matching model relocation recovery.
- Restart reconstruction and stale evidence filtering: RT-063, RT-065 through RT-068, RT-071 through RT-077, RT-081, and RT-082 were fixed by reconstructing ledger tombstones from startup outline/runtime state, treating lower absent runtime IDs as retired after restart, rejecting event-local tab evidence from the wrong live window, and corroborating suspicious full snapshots before reconciliation deletes or moves live tabs.
- Restored-window trace ownership: RT-064, RT-069, RT-070, RT-078, RT-079, and RT-080 were fixed in the trace harness by resolving close expectations through the current live outline node IDs instead of assuming restored runtime IDs equal outline node IDs.
- Command focus active updates: RT-083 through RT-086 were fixed by routing active-only command focus update echoes through the command activation fast path, preserving compact active-state broadcasts without requiring a full runtime snapshot.
- Partial post-restart snapshots for browser-created tabs: RT-087 through RT-090 were fixed by taking one corroborating complete snapshot when a close-missing refresh would otherwise delete a live tab or accept a live tab in the wrong window from suspect query evidence.
- Restore create rejection side effects: RT-091 through RT-095 were fixed by recording restore `createTab`/`createWindow` attempts, detecting matching browser-created tabs/windows from a complete post-rejection snapshot, restoring the original closed outline nodes from that runtime evidence, and clearing reconstructed tombstones for command-restored resources after restart. The same pass also treats the post-command live outline as authoritative for clearing stale command-owned close guards that would otherwise suppress later runtime evidence for still-live resources.
- Outliner close rejection side effects: RT-096, RT-098, and RT-103 were fixed by giving `closeNode` the same transaction/recovery discipline as delete/restore: when the browser close side effect completed before adapter rejection, the controller now preserves the affected outline tab/window as closed, records completed outliner close facts, and updates runtime-index candidates for the recovered close.
- History replay after recovered relocated closes: RT-104 and RT-105 were fixed by preserving closed lifecycle state when old move undo/redo deltas touch a command-closed relocated tab or destination window. History may move the closed outline record, but it must not rematerialize the browser tab/window or synthesize an empty live command-created window.
- Session-only last-tab close in scoped windows: RT-199 through RT-204 were fixed by detecting complete/corroborated missing live window scopes after `sessions.onChanged`, then applying scoped close policy instead of waiting forever for `tabs.onRemoved` or `windows.onRemoved`. Browser-created/session-backed whole-window disappearance is preserved as a closed outline row, while ordinary/restored/command-created last-tab disappearance is treated as native tab deletion unless window-close evidence says the whole window closed. Durable `runtimeProvenance` on outline window nodes lets startup reconstruct browser-created versus command-created ownership without persisting the ephemeral ledger.
- Shape-fresh runtime facts: RT-205 through RT-213 were fixed by normalizing tab events into field-masked `RuntimeTabEvidence` before reconciliation and recording scoped runtime shape facts in the ledger. `created` echoes for already-known tabs and stale `updated` payloads with bundled old `active`/`index` now require corroboration, current shape/order facts can dominate older event-local payloads, and metadata-only updates stay on the compact fast path unless they would change a known node after a suspicious same-window shape change.
- Perf gate for RT-205 through RT-213: `pnpm perf:runtime-guard` passed all 8 scenarios. Sentinels: close tab-removed-then-session firstBroadcastMs=53 totalWithSaveFlushMs=193 saves=1 broadcasts=1; close session-then-tab-removed firstBroadcastMs=49 totalWithSaveFlushMs=187 saves=1 broadcasts=1; restore transient echo firstBroadcastMs=22 totalWithSaveFlushMs=191 saves=1 broadcasts=1; delete last tab firstBroadcastMs=17 totalWithSaveFlushMs=126 saves=1 broadcasts=2; focus last tab firstBroadcastMs=17 totalWithSaveFlushMs=17 saves=0 broadcasts=1; group-live-leaf firstBroadcastMs=75 totalWithSaveFlushMs=221 saves=1 broadcasts=2; move-leaf firstBroadcastMs=43 totalWithSaveFlushMs=218 saves=1 broadcasts=2; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=120 saves=0 broadcasts=0. No budget movement was accepted for this fix.
- History replay after later runtime lifecycle changes: RT-106 through RT-119 and RT-121 through RT-124 were fixed by guarding non-delete history deltas against ledger-removed tab/window targets. Old move/group/top-level undo/redo can still replay outline structure, but if its destination runtime window is tombstoned the current live browser window subtree is preserved, and if its live tab was natively removed the old live node is not rematerialized. A complete runtime reconciliation now runs after history replay so active metadata and live tab/window IDs agree with the browser.
- Native close of command-restored tabs: RT-120 and RT-125 through RT-127 were fixed by treating missing restored live tabs like ordinary native browser removals instead of preserving the restored outline node as closed. Restore commands still preserve outliner-owned close/restore semantics, but a later native tab disappearance deletes the live restored node and tombstones its runtime id.
- Durable lifecycle baseline before side effects: RT-128 through RT-140 were fixed by flushing any pending outline/history save before writing lifecycle journal entries and before touching browser runtime resources. A journal entry now has a durable pre-command outline base to replay against if the background dies after the browser side effect.
- Delete/native tab tombstones after journal recovery: RT-141 through RT-143 and RT-154 were fixed by reinstalling completed delete/native-tab-close tombstones during startup journal recovery, so stale event-local evidence cannot resurrect tabs that the browser already removed.
- Native window-close pending-save recovery: RT-144 through RT-153 were fixed by journaling browser-native window close transitions before applying the model close. Startup consumes the journal only when a complete runtime snapshot confirms the window/tabs are gone, then preserves the closed outline subtree and clears the hint after persistence.
- Browser-authored native move convergence: RT-155 through RT-164 were fixed by treating same-tab/different-window evidence as a structural browser-authored move instead of an ignorable stale tab event. The controller now listens for native attach/detach/moved signals, cross-window tab events bail to reconciliation, stale event-local mismatches are corroborated before acceptance, and ledger live-id learning accepts browser-observed resources without clearing tombstones.
- Browser-authored live resource preservation during history replay: RT-165 through RT-170 were fixed by preserving currently live runtime tabs/windows from a complete snapshot when structural undo/redo replays an older outline shape. History replay still applies the requested command delta, but unrelated browser-created or browser-moved resources survive, confirmed live windows can be re-rooted, and the replay result is reconciled against current browser evidence before persistence.
- Perf gate for RT-155 through RT-170: `pnpm perf:runtime-guard` passed all 8 scenarios. Targeted 50k-tab profiles: group-live-leaf firstBroadcastMs=91 totalWithSaveFlushMs=217 saves=1 broadcasts=2; move-leaf firstBroadcastMs=39 totalWithSaveFlushMs=183 saves=1 broadcasts=2; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=76 saves=0 broadcasts=0; focus-last firstBroadcastMs=19 totalWithSaveFlushMs=20 saves=0 broadcasts=1. No budget movement was accepted for this fix.
- Runtime shape authority: RT-171 through RT-176, RT-180, and RT-181 were fixed by treating browser tab order and active fallback as runtime shape facts during reconciliation. Native attached/moved/detached events now force snapshot reconciliation instead of falling through a metadata-only fast path, suspicious reordered snapshots are corroborated once before changing outline preorder, and `reconcileWithWindows` can apply browser tab-index order when invoked from runtime reconciliation while preserving normal user/history outline moves.
- Browser-authored move-back after command relocation: RT-177 through RT-179 were fixed by recording native attach/move facts in the ledger and clearing command-relocated old-window echo protection when the browser moves the same tab away from the command destination. Stale old-window echoes remain filtered, but a real later browser-authored move back to the source window is accepted.
- Restored-resource metadata freshness: RT-182 through RT-186 were fixed by keeping restored-tab stale protection long enough to corroborate suspicious metadata echoes. Transient `about:blank`/`New Tab` restore echoes are absorbed without a full snapshot; later restored-tab metadata changes are accepted only when fresh runtime evidence corroborates them, so stale created/updated echoes cannot overwrite current title/url/favicon.
- Perf gate for RT-171 through RT-186: `pnpm perf:runtime-guard` passed all 8 scenarios. Key 50k-tab sentinels: restore transient echo firstBroadcastMs=17 totalWithSaveFlushMs=153 saves=1 broadcasts=1; group-live-leaf firstBroadcastMs=90 totalWithSaveFlushMs=219 saves=1 broadcasts=2; move-leaf firstBroadcastMs=39 totalWithSaveFlushMs=182 saves=1 broadcasts=2; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=94 saves=0 broadcasts=0. No budget movement was accepted for this fix.
- External browser-created window close: UR-001 was fixed by recording browser-created runtime windows in the ephemeral ledger and treating corroborated session-only disappearance as native window-close evidence. The affected outline window/tab subtree is now preserved as closed, native close lifecycle journaling protects the pending save, and removed runtime IDs stay tombstoned so stale created/updated echoes cannot resurrect the live row.
- Perf gate for UR-001: `pnpm perf:runtime-guard` passed all 8 scenarios. Key sentinels: close tab-removed-then-session firstBroadcastMs=42 totalWithSaveFlushMs=159 saves=1 broadcasts=1; close session-then-tab-removed firstBroadcastMs=43 totalWithSaveFlushMs=163 saves=1 broadcasts=1; refresh-noop firstBroadcastMs=0 totalWithSaveFlushMs=93 saves=0 broadcasts=0. No budget movement was accepted for this fix.
- Post-recovery harness artifacts: RT-097, RT-099, RT-100, RT-101, and RT-102 were triaged as trace-harness bugs, not runtime model bugs. The harness now avoids stale `lastOpenedWindow`/old restored-tab runtime IDs, treats a foreign live window under a closed source window as intentionally promoted/still live, permits no focused runtime window after destructive history replay by selecting `firstRuntimeWindow` for query skew, and scopes rejecting restore-create mocks to the selected node kind so unused one-shot mocks cannot poison later undo/redo commands.
- Verification: all listed generated seed repros and promoted domain trace repros pass as of the principled runtime trace fix passes.

## User-Reported Runtime Findings

### UR-001 external browser-created window remains live after browser close
<!-- signature: external browser-created window/tab remains live after browser-authored close with incomplete close events -->

- First seen: 2026-05-25 during manual browser testing.
- Repro: externally open a link into a new browser window/tab so Tabs Outliner creates live `window:<id>` and `tab:<id>` nodes; close that window from browser chrome with only session or tabs-removed evidence; stale created/updated tab evidence could leave the outline row live.
- Regression trace: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ur-external-window-tabs-only-close-stale-echo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in the external browser-created window close pass.

## Restart-Stress Fix Analysis

- Lost relocated-resource protection after restart: RT-063, RT-065 through RT-068, RT-071 through RT-077, RT-081, and RT-082 showed stale old-window events or stale manual query evidence resurrecting moved/deleted relocated tabs after command-created destinations disappeared across a background restart; fixed by restart reconstruction plus stale/mismatched evidence filtering.
- Restored-window close ownership after restart: RT-064, RT-069, RT-070, RT-078, RT-079, and RT-080 showed restored windows being reported as missing by the harness when native or outliner close happened after restart; fixed by resolving expected restored outline nodes by current live runtime IDs.
- Command focus active-state reconstruction after restart: RT-083 through RT-086 showed command focus leaving outline `active` flags stale before later refresh/activation variants; fixed by applying active-only focus update echoes through the command activation path.
- Partial post-restart snapshots for browser-created tabs: RT-087 through RT-090 showed `tabs.query` snapshots missing a live browser-created tab being treated as deletion evidence after restart; fixed by corroborating suspicious close-missing snapshots.

## Previous Adaptive Seed-Frontier Run

- Completed: 2026-05-23T10:32:29.655Z
- Strategy: adaptive deterministic frontier, with mutations around newly failing seeds and mixed global probes
- Distinct adaptive findings recorded: 8
- Stop condition reached: iterations 12, 13, and 14 found no new distinct signatures
- Duplicate failures during final clean streak: 157

## Previous Adaptive Findings

### RT-001 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
step: concurrent-activated-tab-then-group
dispatch tab <id> activated, then group tab <id> -->

- First seen: 2026-05-23T09:47:00.099Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10001 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10001
step 1: concurrent-activated-tab-then-group
dispatch tab 2 activated, then group tab 1
```

<!-- hunt-iteration: {"at":"2026-05-23T09:47:00.100Z","iteration":1,"firstSeed":10000,"lastSeed":10001,"runs":2,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-002 tab 101 active flag diverged
<!-- signature: tab <id> active flag diverged
step: concurrent-created-tab-then-group
dispatch tab <id> created, then group tab <id> -->

- First seen: 2026-05-23T09:47:14.597Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10020 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10020
step 1: outliner-close-window
outliner close window 10 with 2 tabs
step 2: open-tab
open tab 100 in window 20 with stale query
step 3: concurrent-focused-window-then-group
dispatch window 20 focused, then group tab 100
step 4: outliner-delete-window-rejecting-close
outliner delete window 21 with rejecting close
step 5: open-tab
open tab 101 in window 20
step 6: concurrent-created-tab-then-group
dispatch tab 102 created, then group tab 101
```

<!-- hunt-iteration: {"at":"2026-05-23T09:47:14.598Z","iteration":2,"firstSeed":10002,"lastSeed":10020,"runs":15,"failures":3,"duplicateFailures":2,"newFindings":1} -->

### RT-003 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
step: activate-tab-with-stale-query
 -->

- First seen: 2026-05-23T09:48:54.164Z
- Repro: `env GENERATED_TRACE_BASE_SEED=1892143700 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 1892143700
step 1: concurrent-focused-window-then-group
dispatch window 10 focused, then group tab 2
step 2: native-close-tab
native close last tab 2 in window 21
step 3: concurrent-activated-tab-then-group
step 4: open-tab
open tab 100 in window 20
step 5: native-close-tab
native close last tab 1 in window 10
step 6: concurrent-focused-window-then-group
dispatch window 20 focused, then group tab 100
step 7: concurrent-focused-window-then-group
step 8: activate-tab-with-stale-query
activate tab 100 with stale query for moved tab 100
step 9: concurrent-activated-tab-then-group
step 10: concurrent-updated-tab-then-group
step 11: open-tab
open tab 101 in window 20
step 12: activate-tab
activate tab 3
step 13: concurrent-updated-tab-then-group
dispatch tab 100 updated, then group tab 101
step 14: activate-tab-with-stale-query
activate tab 100 with stale query for moved tab 100
```

<!-- hunt-iteration: {"at":"2026-05-23T09:48:54.164Z","iteration":3,"firstSeed":10019,"lastSeed":1892143700,"runs":103,"failures":11,"duplicateFailures":10,"newFindings":1} -->

### RT-004 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
step: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:52:31.734Z
- Repro: `env GENERATED_TRACE_BASE_SEED=560291164 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 560291164
step 1: open-tab
open tab 100 in window 10 with stale query
step 2: native-close-window
native close multi-tab window 10
step 3: open-tab
open tab 101 in window 20
step 4: open-tab
open tab 102 in window 20
step 5: concurrent-focused-window-then-group
dispatch window 20 focused, then group tab 102
step 6: concurrent-updated-tab-then-group
dispatch tab 102 updated, then group tab 3
step 7: open-tab
open tab 103 in window 22
step 8: open-tab
open tab 104 in window 20 with stale query
step 9: outliner-move-tab-new-window
outliner move tab 104 to new window
step 10: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 102 with stale query window 20
```

<!-- hunt-iteration: {"at":"2026-05-23T09:52:31.735Z","iteration":4,"firstSeed":1892143701,"lastSeed":560291164,"runs":202,"failures":37,"duplicateFailures":36,"newFindings":1} -->

### RT-005 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
step: activate-tab-with-stale-query
 -->

- First seen: 2026-05-23T09:52:55.009Z
- Repro: `env GENERATED_TRACE_BASE_SEED=560291075 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 560291075
step 1: concurrent-activated-tab-then-group
dispatch tab 1 activated, then group tab 1
step 2: concurrent-focused-window-then-group
step 3: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 1 with stale query window 10
step 4: concurrent-focused-window-then-group
step 5: outliner-delete-window-rejecting-close
outliner delete window 21 with rejecting close
step 6: outliner-restore-delete-window-delayed-event
outliner restore-delete window 20 with delayed restored-tab event
step 7: concurrent-activated-tab-then-group
step 8: concurrent-activated-tab-then-group
step 9: concurrent-activated-tab-then-group
step 10: concurrent-created-tab-then-group
step 11: activate-tab
activate tab 2
step 12: open-tab
open tab 100 in window 10 with stale query
step 13: open-tab
open tab 101 in window 10
step 14: outliner-move-tab-new-window
outliner move tab 2 to new window
step 15: stale-live-tab-updated-event
dispatch stale live updated event for tab 100 in old window 10
step 16: open-tab
open tab 102 in window 23 with stale query
step 17: open-tab
open tab 103 in window 10
step 18: concurrent-updated-tab-then-group
dispatch tab 2 updated, then group tab 100
step 19: open-tab
open tab 104 in window 24
step 20: activate-tab
activate tab 100
step 21: concurrent-updated-tab-then-group
dispatch tab 2 updated, then group tab 103
step 22: open-tab
open tab 105 in window 23 with stale query
step 23: outliner-close-tab
outliner close tab 100
step 24: activate-tab
activate tab 105
step 25: outliner-group-tab
outliner group tab 2
step 26: activate-tab-with-stale-query
activate tab 2 with stale query for moved tab 2
```

<!-- hunt-iteration: {"at":"2026-05-23T09:52:55.010Z","iteration":5,"firstSeed":560291165,"lastSeed":560291075,"runs":20,"failures":3,"duplicateFailures":2,"newFindings":1} -->

<!-- hunt-iteration: {"at":"2026-05-23T09:57:53.279Z","iteration":6,"firstSeed":560291076,"lastSeed":822530453,"runs":289,"failures":57,"duplicateFailures":57,"newFindings":0} -->

### RT-006 tab 102 has wrong live window
<!-- signature: tab <id> has wrong live window
step: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab <id> with stale query window <id> -->

- First seen: 2026-05-23T10:02:00.255Z
- Repro: `env GENERATED_TRACE_BASE_SEED=1429519014 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 1429519014
step 1: concurrent-focused-window-then-group
dispatch window 20 focused, then group tab 1
step 2: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 1 with stale query window 10
step 3: native-close-tab
native close last tab 2 in window 10
step 4: open-tab
open tab 100 in window 20
step 5: native-close-tab
native close tab 3 with sessionChangedOnly
step 6: native-close-tab
native close last tab 100 in window 20
step 7: concurrent-focused-window-then-group
step 8: concurrent-created-tab-then-group
step 9: concurrent-updated-tab-then-group
step 10: open-tab
open tab 101 in window 21
step 11: open-tab
open tab 102 in window 21
step 12: open-tab
open tab 103 in window 21
step 13: outliner-group-tab
outliner group tab 1
step 14: open-tab
open tab 104 in window 21 with stale query
step 15: native-close-window
native close multi-tab window 21
step 16: outliner-group-tab
outliner group tab 102
step 17: open-tab
open tab 105 in window 23
step 18: stale-live-tab-updated-event
dispatch stale live updated event for tab 102 in old window 22
step 19: stale-live-tab-updated-event
dispatch stale live updated event for tab 102 in old window 22
step 20: outliner-move-tab-new-window
outliner move tab 105 to new window
step 21: open-tab
open tab 106 in window 23 with stale query
step 22: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 105 with stale query window 23
step 23: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 105 with stale query window 23
step 24: concurrent-updated-tab-then-group
dispatch tab 102 updated, then group tab 101
step 25: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 102 with stale query window 22
```

<!-- hunt-iteration: {"at":"2026-05-23T10:02:00.255Z","iteration":7,"firstSeed":570178208,"lastSeed":1429519014,"runs":258,"failures":43,"duplicateFailures":42,"newFindings":1} -->

### RT-007 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
step: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab <id> with stale query window <id> -->

- First seen: 2026-05-23T10:03:18.235Z
- Repro: `env GENERATED_TRACE_BASE_SEED=2055959888 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 2055959888
step 1: outliner-group-tab
outliner group tab 2
step 2: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 2 with stale query window 10
step 3: open-tab
open tab 100 in window 20
step 4: open-tab
open tab 101 in window 21
step 5: stale-live-tab-updated-event
dispatch stale live updated event for tab 2 in old window 10
step 6: concurrent-created-tab-then-group
dispatch tab 102 created, then group tab 101
step 7: open-tab
open tab 103 in window 20 with stale query
step 8: native-close-tab
native close tab 103 with tabRemovedThenSessionChanged
step 9: concurrent-created-tab-then-group
dispatch tab 104 created, then group tab 102
step 10: open-tab
open tab 105 in window 21
step 11: concurrent-focused-window-then-group
dispatch window 10 focused, then group tab 104
step 12: concurrent-updated-tab-then-group
dispatch tab 102 updated, then group tab 105
step 13: stale-live-tab-updated-event
dispatch stale live updated event for tab 105 in old window 21
step 14: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 102 with stale query window 21
```

<!-- hunt-iteration: {"at":"2026-05-23T10:03:18.235Z","iteration":8,"firstSeed":1429519015,"lastSeed":2055959888,"runs":78,"failures":17,"duplicateFailures":16,"newFindings":1} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:08:17.318Z","iteration":9,"firstSeed":2055959889,"lastSeed":110939912,"runs":276,"failures":52,"duplicateFailures":52,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:13:15.921Z","iteration":10,"firstSeed":827338997,"lastSeed":1621964926,"runs":295,"failures":51,"duplicateFailures":51,"newFindings":0} -->

### RT-008 tab 1 has wrong live window
<!-- signature: tab <id> has wrong live window
step: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab <id> with stale query window <id> -->

- First seen: 2026-05-23T10:17:34.391Z
- Repro: `env GENERATED_TRACE_BASE_SEED=1384879344 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 1384879344
step 1: outliner-move-tab-new-window
outliner move tab 1 to new window
step 2: activate-tab-with-stale-query
activate tab 1 with stale query for moved tab 1
step 3: stale-live-tab-updated-event
dispatch stale live updated event for tab 1 in old window 10
step 4: open-tab
open tab 100 in window 20 with stale query
step 5: open-tab
open tab 101 in window 21 with stale query
step 6: native-close-tab
native close tab 100 with tabRemovedThenSessionChanged
step 7: concurrent-updated-tab-then-group
dispatch tab 1 updated, then group tab 101
step 8: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 1 with stale query window 10
```

<!-- hunt-iteration: {"at":"2026-05-23T10:17:34.392Z","iteration":11,"firstSeed":1766343339,"lastSeed":1384879344,"runs":244,"failures":40,"duplicateFailures":39,"newFindings":1} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:22:33.379Z","iteration":12,"firstSeed":1384879345,"lastSeed":112808897,"runs":281,"failures":52,"duplicateFailures":52,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:27:31.497Z","iteration":13,"firstSeed":1963229263,"lastSeed":1329790459,"runs":291,"failures":53,"duplicateFailures":53,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:32:29.655Z","iteration":14,"firstSeed":788727522,"lastSeed":290892481,"runs":297,"failures":52,"duplicateFailures":52,"newFindings":0} -->

## Recovered Seed-Sweep Run

These findings were recovered from the committed pre-adaptive seed sweep (`HEAD:RUNTIME_TRACE_BUGS.md`).
That run scanned seeds 10000 through 11496 sequentially, recorded 6 distinct signatures, and stopped after
iterations 8, 9, and 10 found no new distinct signatures. Several signatures overlap with the adaptive run, but
the original seeds and traces are kept here so the evidence is not lost.

### SS-001 tab 1 active flag diverged
<!-- seed-sweep-signature: tab <id> active flag diverged
step: concurrent-activated-tab-then-group
dispatch tab <id> activated, then group tab <id> -->

- First seen: 2026-05-23T09:13:27.016Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10001 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10001
step 1: concurrent-activated-tab-then-group
dispatch tab 2 activated, then group tab 1
```

### SS-002 tab 101 active flag diverged
<!-- seed-sweep-signature: tab <id> active flag diverged
step: concurrent-created-tab-then-group
dispatch tab <id> created, then group tab <id> -->

- First seen: 2026-05-23T09:13:45.142Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10020 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10020
step 1: outliner-close-window
outliner close window 10 with 2 tabs
step 2: open-tab
open tab 100 in window 20 with stale query
step 3: concurrent-focused-window-then-group
dispatch window 20 focused, then group tab 100
step 4: outliner-delete-window-rejecting-close
outliner delete window 21 with rejecting close
step 5: open-tab
open tab 101 in window 20
step 6: concurrent-created-tab-then-group
dispatch tab 102 created, then group tab 101
```

### SS-003 live window IDs match runtime windows
<!-- seed-sweep-signature: live window IDs match runtime windows
step: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:16:13.394Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10175 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10175
step 1: concurrent-created-tab-then-group
dispatch tab 100 created, then group tab 1
step 2: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 1 with stale query window 10
step 3: activate-tab
activate tab 3
step 4: concurrent-updated-tab-then-group
dispatch tab 1 updated, then group tab 3
step 5: concurrent-activated-tab-then-group
step 6: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 1 with stale query window 10
```

### SS-004 live window IDs match runtime windows
<!-- seed-sweep-signature: live window IDs match runtime windows
step: activate-tab-with-stale-query
 -->

- First seen: 2026-05-23T09:17:15.938Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10240 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10240
step 1: concurrent-updated-tab-then-group
dispatch tab 2 updated, then group tab 1
step 2: activate-tab
activate tab 2
step 3: native-close-tab
native close last tab 1 in window 21
step 4: open-tab
open tab 100 in window 10 with stale query
step 5: open-tab
open tab 101 in window 10
step 6: concurrent-activated-tab-then-group
dispatch tab 3 activated, then group tab 100
step 7: concurrent-updated-tab-then-group
dispatch tab 100 updated, then group tab 101
step 8: activate-tab
activate tab 100
step 9: activate-tab-with-stale-query
activate tab 100 with stale query for moved tab 100
```

### SS-005 tab 101 has wrong live window
<!-- seed-sweep-signature: tab <id> has wrong live window
step: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:17:47.746Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10267 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10267
step 1: open-tab
open tab 100 in window 20
step 2: outliner-close-window
outliner close window 20 with 2 tabs
step 3: open-tab
open tab 101 in window 10
step 4: outliner-group-tab
outliner group tab 101
step 5: open-tab
open tab 102 in window 10
step 6: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 101 with stale query window 10
step 7: concurrent-updated-tab-then-group
dispatch tab 102 updated, then group tab 102
step 8: concurrent-updated-tab-then-group
dispatch tab 101 updated, then group tab 1
step 9: concurrent-focused-window-then-group
step 10: open-tab
open tab 103 in window 21
step 11: outliner-close-window
outliner close window 23 with 1 tabs
step 12: open-tab
open tab 104 in window 10
step 13: concurrent-focused-window-then-group
dispatch window 10 focused, then group tab 104
step 14: stale-live-tab-updated-event
dispatch stale live updated event for tab 101 in old window 10
step 15: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 101 with stale query window 10
```

### SS-006 live window IDs match runtime windows
<!-- seed-sweep-signature: live window IDs match runtime windows
step: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:24:16.720Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10636 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
seed 10636
step 1: outliner-group-tab
outliner group tab 1
step 2: open-tab
open tab 100 in window 20 with stale query
step 3: concurrent-activated-tab-then-group
dispatch tab 100 activated, then group tab 100
step 4: outliner-close-window
outliner close window 21 with 1 tabs
step 5: open-tab
open tab 101 in window 20
step 6: activate-tab-with-stale-query
activate tab 100 with stale query for moved tab 100
step 7: concurrent-updated-tab-then-group
dispatch tab 100 updated, then group tab 101
step 8: activate-tab
activate tab 3
step 9: concurrent-focused-window-then-group
step 10: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 100 with stale query window 20
```

## Domain Trace Findings

### RT-009 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: rt-active-race
action: {"type":"raceWithOutlinerGroup","event":{"type":"activateTab","tab":{"tabId":2}},"groupTab":{"tabId":1},"captureStaleTabs":"grouped-tab-1"} -->

- First seen: 2026-05-23T10:58:27.512Z
- Trace id: `rt-active-race`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-active-race pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-active-race: activation event races a live-tab grouping command
action 1: {"type":"raceWithOutlinerGroup","event":{"type":"activateTab","tab":{"tabId":2}},"groupTab":{"tabId":1},"captureStaleTabs":"grouped-tab-1"}
Domain trace: rt-active-race
Action 1: {"type":"raceWithOutlinerGroup","event":{"type":"activateTab","tab":{"tabId":2}},"groupTab":{"tabId":1},"captureStaleTabs":"grouped-tab-1"}
Trace:
domain trace rt-active-race: activation event races a live-tab grouping command
action 1: {"type":"raceWithOutlinerGroup","event":{"type":"activateTab","tab":{"tabId":2}},"groupTab":{"tabId":1},"captureStaleTabs":"grouped-tab-1"}
```

### RT-010 tab 101 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: rt-created-race-after-window-close
action: {"type":"raceWithOutlinerGroup","event":{"type":"openTab","window":{"windowId":20},"captureTab":"tab-102"},"groupTab":{"capture":"tab-101"},"captureStaleTabs":"tab-101-before-created-race"} -->

- First seen: 2026-05-23T10:58:28.457Z
- Trace id: `rt-created-race-after-window-close`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-created-race-after-window-close pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-created-race-after-window-close: created-tab event races grouping after source-window closure
action 1: {"type":"outlinerCloseWindow","window":{"windowId":10}}
action 2: {"type":"openTab","window":{"windowId":20},"captureTab":"tab-100"}
action 3: {"type":"raceWithOutlinerGroup","event":{"type":"focusWindow","window":{"windowId":20}},"groupTab":{"capture":"tab-100"},"captureStaleTabs":"tab-100-before-focus-race"}
action 4: {"type":"outlinerDeleteWindowRejectingClose","window":{"role":"lastOpenedWindow"}}
action 5: {"type":"openTab","window":{"windowId":20},"captureTab":"tab-101"}
action 6: {"type":"raceWithOutlinerGroup","event":{"type":"openTab","window":{"windowId":20},"captureTab":"tab-102"},"groupTab":{"capture":"tab-101"},"captureStaleTabs":"tab-101-before-created-race"}
Domain trace: rt-created-race-after-window-close
Action 6: {"type":"raceWithOutlinerGroup","event":{"type":"openTab","window":{"windowId":20},"captureTab":"tab-102"},"groupTab":{"capture":"tab-101"},"captureStaleTabs":"tab-101-before-created-race"}
Trace:
domain trace rt-created-race-after-window-close: created-tab event races grouping after source-window closure
action 1: {"type":"outlinerCloseWindow","window":{"windowId":10}}
action 2: {"type":"openTab","window":{"windowId":20},"captureTab":"tab-100"}
action 3: {"type":"raceWithOutlinerGroup","event":{"type":"focusWindow","window":{"windowId":20}},"groupTab":{"capture":"tab-100"},"captureStaleTabs":"tab-100-before-focus-race"}
action 4: {"type":"outlinerDeleteWindowRejectingClose","window":{"role":"lastOpenedWindow"}}
action 5: {"type":"openTab","window":{"windowId":20},"captureTab":"tab-101"}
action 6: {"type":"raceWithOutlinerGroup","event":{"type":"openTab","window":{"windowId":20},"captureTab":"tab-102"},"groupTab":{"capture":"tab-101"},"captureStaleTabs":"tab-101-before-created-race"}
```

<!-- hunt-iteration: {"at":"2026-05-23T10:58:32.266Z","iteration":1,"firstTraceId":"rt-active-race","lastTraceId":"rt-restore-delete-delayed-stale-event","runs":6,"failures":2,"duplicateFailures":0,"newFindings":2} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:58:39.166Z","iteration":2,"firstTraceId":"rt-active-race","lastTraceId":"rt-restore-delete-delayed-stale-event","runs":6,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:58:45.643Z","iteration":3,"firstTraceId":"rt-active-race","lastTraceId":"rt-restore-delete-delayed-stale-event","runs":6,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T10:58:52.252Z","iteration":4,"firstTraceId":"rt-active-race","lastTraceId":"rt-restore-delete-delayed-stale-event","runs":6,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T11:56:20.113Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-restore-delete-delayed-stale-event","runs":9,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T11:58:53.977Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-top-level-stale-updated-after-fresh-event","runs":11,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-011 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: rt-repeated-direct-relocation-stale-events
action: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"role":"lastMovedTab"},"captureStaleTabs":"second-direct-old-window"} -->

- First seen: 2026-05-23T12:00:05.387Z
- Trace id: `rt-repeated-direct-relocation-stale-events`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-repeated-direct-relocation-stale-events pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-repeated-direct-relocation-stale-events: stale events from multiple old windows follow repeated direct relocation
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"first-direct-old-window"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"role":"lastMovedTab"},"captureStaleTabs":"second-direct-old-window"}
Domain trace: rt-repeated-direct-relocation-stale-events
Action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"role":"lastMovedTab"},"captureStaleTabs":"second-direct-old-window"}
Trace:
domain trace rt-repeated-direct-relocation-stale-events: stale events from multiple old windows follow repeated direct relocation
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"first-direct-old-window"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"role":"lastMovedTab"},"captureStaleTabs":"second-direct-old-window"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:00:05.388Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-repeated-direct-relocation-stale-events","runs":12,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:01:06.206Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-repeated-direct-relocation-with-filler-stale-events","runs":13,"completedCorpus":true,"failures":1,"duplicateFailures":1,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:02:09.481Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-repeated-direct-relocation-native-close-stale-event","runs":14,"completedCorpus":true,"failures":1,"duplicateFailures":1,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:03:00.391Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-repeated-top-level-relocation-with-filler-stale-events","runs":15,"completedCorpus":true,"failures":1,"duplicateFailures":1,"newFindings":0} -->

### RT-012 expected closed node window:10 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: rt-direct-new-window-native-close-old-window-stale-created
action: {"type":"nativeCloseWindow","window":{"windowId":10}} -->

- First seen: 2026-05-23T12:09:19.101Z
- Trace id: `rt-direct-new-window-native-close-old-window-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-direct-new-window-native-close-old-window-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-direct-new-window-native-close-old-window-stale-created: stale created event follows direct relocation after native old-window close
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"direct-old-window-before-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
Domain trace: rt-direct-new-window-native-close-old-window-stale-created
Action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
Trace:
domain trace rt-direct-new-window-native-close-old-window-stale-created: stale created event follows direct relocation after native old-window close
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"direct-old-window-before-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
```

### RT-013 expected closed node window:10 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: rt-top-level-native-close-old-window-stale-created
action: {"type":"nativeCloseWindow","window":{"windowId":10}} -->

- First seen: 2026-05-23T12:09:21.125Z
- Trace id: `rt-top-level-native-close-old-window-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-top-level-native-close-old-window-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-top-level-native-close-old-window-stale-created: stale created event follows top-level relocation after native old-window close
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
Domain trace: rt-top-level-native-close-old-window-stale-created
Action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
Trace:
domain trace rt-top-level-native-close-old-window-stale-created: stale created event follows top-level relocation after native old-window close
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
```

### RT-014 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: rt-group-native-close-old-window-stale-updated
action: {"type":"nativeCloseWindow","window":{"windowId":10}} -->

- First seen: 2026-05-23T12:09:22.104Z
- Trace id: `rt-group-native-close-old-window-stale-updated`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-group-native-close-old-window-stale-updated pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-group-native-close-old-window-stale-updated: stale updated event follows grouping relocation after native old-window close
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-old-window-before-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
Domain trace: rt-group-native-close-old-window-stale-updated
Action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
Trace:
domain trace rt-group-native-close-old-window-stale-updated: stale updated event follows grouping relocation after native old-window close
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-old-window-before-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:09:22.104Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-native-close-old-window-stale-updated","runs":19,"completedCorpus":true,"failures":4,"duplicateFailures":1,"newFindings":3} -->

### RT-015 domain window close rejected after completion
<!-- signature: domain window close rejected after completion
domain trace: rt-group-delete-old-window-rejecting-close-stale-created
action: {"type":"outlinerDeleteWindowRejectingClose","window":{"windowId":10}} -->

- First seen: 2026-05-23T12:10:40.932Z
- Trace id: `rt-group-delete-old-window-rejecting-close-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-group-delete-old-window-rejecting-close-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-group-delete-old-window-rejecting-close-stale-created: stale created event follows grouping relocation after delete-owned old-window close
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-old-window-before-delete-close"}
action 2: {"type":"outlinerDeleteWindowRejectingClose","window":{"windowId":10}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:10:42.915Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-outliner-close-old-window-stale-updated","runs":24,"completedCorpus":true,"failures":5,"duplicateFailures":4,"newFindings":1} -->

### RT-016 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: rt-direct-new-window-native-close-destination-stale-updated
action: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"}} -->

- First seen: 2026-05-23T12:12:05.042Z
- Trace id: `rt-direct-new-window-native-close-destination-stale-updated`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-direct-new-window-native-close-destination-stale-updated pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-direct-new-window-native-close-destination-stale-updated: stale updated event follows native destination-window close after direct relocation
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"direct-old-window-before-destination-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"}}
Domain trace: rt-direct-new-window-native-close-destination-stale-updated
Action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"}}
Trace:
domain trace rt-direct-new-window-native-close-destination-stale-updated: stale updated event follows native destination-window close after direct relocation
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"direct-old-window-before-destination-native-close"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:12:08.441Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-outliner-close-destination-stale-created","runs":28,"completedCorpus":true,"failures":6,"duplicateFailures":5,"newFindings":1} -->

### RT-017 native-deleted node tab:1 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: rt-top-level-native-close-tab-removed-only-stale-created
action: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"tabRemovedOnly"} -->

- First seen: 2026-05-23T12:13:37.651Z
- Trace id: `rt-top-level-native-close-tab-removed-only-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-top-level-native-close-tab-removed-only-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-top-level-native-close-tab-removed-only-stale-created: stale created event follows top-level relocation after tab-removed-only native close
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-tab-removed-only"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"tabRemovedOnly"}
Domain trace: rt-top-level-native-close-tab-removed-only-stale-created
Action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"tabRemovedOnly"}
Trace:
domain trace rt-top-level-native-close-tab-removed-only-stale-created: stale created event follows top-level relocation after tab-removed-only native close
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-tab-removed-only"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"tabRemovedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:13:38.658Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-native-close-session-only-stale-updated","runs":32,"completedCorpus":true,"failures":7,"duplicateFailures":6,"newFindings":1} -->

### RT-018 native-deleted node tab:1 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: rt-top-level-native-close-session-only-stale-updated
action: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-23T12:15:05.701Z
- Trace id: `rt-top-level-native-close-session-only-stale-updated`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-top-level-native-close-session-only-stale-updated pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-top-level-native-close-session-only-stale-updated: stale updated event follows top-level relocation after session-only native close
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-session-only"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Domain trace: rt-top-level-native-close-session-only-stale-updated
Action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Trace:
domain trace rt-top-level-native-close-session-only-stale-updated: stale updated event follows top-level relocation after session-only native close
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-session-only"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:15:08.045Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-direct-new-window-native-close-default-order-stale-created","runs":35,"completedCorpus":true,"failures":8,"duplicateFailures":7,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:16:51.275Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-stale-activation-after-focus","runs":38,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:18:20.150Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-old-window-activation-with-stale-relocated-tab","runs":41,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:22:37.686Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-command-focus-stale-updated","runs":44,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

### RT-019 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: rt-direct-new-window-delete-tab-rejecting-close-stale-created
action: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}} -->

- First seen: 2026-05-23T12:24:27.228Z
- Trace id: `rt-direct-new-window-delete-tab-rejecting-close-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-direct-new-window-delete-tab-rejecting-close-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-direct-new-window-delete-tab-rejecting-close-stale-created: stale created event follows direct relocation after delete-owned tab close rejection
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"direct-old-window-before-delete-tab"}
action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
Domain trace: rt-direct-new-window-delete-tab-rejecting-close-stale-created
Action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
Trace:
domain trace rt-direct-new-window-delete-tab-rejecting-close-stale-created: stale created event follows direct relocation after delete-owned tab close rejection
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"direct-old-window-before-delete-tab"}
action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
```

### RT-020 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: rt-top-level-delete-tab-rejecting-close-stale-updated
action: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}} -->

- First seen: 2026-05-23T12:24:28.425Z
- Trace id: `rt-top-level-delete-tab-rejecting-close-stale-updated`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-top-level-delete-tab-rejecting-close-stale-updated pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-top-level-delete-tab-rejecting-close-stale-updated: stale updated event follows top-level relocation after delete-owned tab close rejection
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-delete-tab"}
action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
Domain trace: rt-top-level-delete-tab-rejecting-close-stale-updated
Action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
Trace:
domain trace rt-top-level-delete-tab-rejecting-close-stale-updated: stale updated event follows top-level relocation after delete-owned tab close rejection
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-old-window-before-delete-tab"}
action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
```

### RT-021 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: rt-group-delete-tab-rejecting-close-stale-created
action: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}} -->

- First seen: 2026-05-23T12:24:29.644Z
- Trace id: `rt-group-delete-tab-rejecting-close-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=rt-group-delete-tab-rejecting-close-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace rt-group-delete-tab-rejecting-close-stale-created: stale created event follows grouping relocation after delete-owned tab close rejection
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-old-window-before-delete-tab"}
action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
Domain trace: rt-group-delete-tab-rejecting-close-stale-created
Action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
Trace:
domain trace rt-group-delete-tab-rejecting-close-stale-created: stale created event follows grouping relocation after delete-owned tab close rejection
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-old-window-before-delete-tab"}
action 2: {"type":"outlinerDeleteTabRejectingClose","tab":{"role":"lastMovedTab"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T12:24:29.644Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-delete-tab-rejecting-close-stale-created","runs":47,"completedCorpus":true,"failures":11,"duplicateFailures":8,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:26:33.600Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-outliner-close-tab-stale-updated","runs":50,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:28:17.750Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-close-source-tab-stale-created","runs":53,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:31:50.005Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-stale-updated-fast-path-after-fresh-event","runs":56,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:33:38.602Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-paired-stale-events-after-fresh-event","runs":59,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:37:21.785Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-open-active-source-tab-stale-updated","runs":62,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T12:39:16.910Z","mode":"agent-corpus-run","firstTraceId":"rt-active-race","lastTraceId":"rt-group-open-active-destination-tab-stale-created","runs":65,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

### RT-022 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: dh-undo-redo-stale-refresh
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"undo-redo-before-stale"},"withStaleQuery":true} -->

- First seen: 2026-05-23T14:59:15.837Z
- Trace id: `dh-undo-redo-stale-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-undo-redo-stale-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-undo-redo-stale-refresh: undo redo around stale runtime events and refresh
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"undo-redo-before-stale"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"undo-redo-before-stale"},"withStaleQuery":true}
Domain trace: dh-undo-redo-stale-refresh
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"undo-redo-before-stale"},"withStaleQuery":true}
Trace:
domain trace dh-undo-redo-stale-refresh: undo redo around stale runtime events and refresh
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"undo-redo-before-stale"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"undo-redo-before-stale"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T14:59:15.838Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","delayed-event","delete-rejection","focus","manual-refresh","native-close","nested-window","opener","partial-close","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-undo-redo-stale-refresh","runs":6,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:00:42.558Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","delayed-event","delete-rejection","focus","manual-refresh","native-close","nested-window","opener","partial-close","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-refresh-delete-reject-relocated-tab","runs":9,"completedCorpus":true,"failures":1,"duplicateFailures":1,"newFindings":0} -->

### RT-023 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: dh-history-redo-stale-created
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"history-created-before-stale"},"withStaleQuery":true} -->

- First seen: 2026-05-23T15:02:09.141Z
- Trace id: `dh-history-redo-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-history-redo-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-history-redo-stale-created: history redo followed by stale created echo
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"history-created-before-stale"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"history-created-before-stale"},"withStaleQuery":true}
Domain trace: dh-history-redo-stale-created
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"history-created-before-stale"},"withStaleQuery":true}
Trace:
domain trace dh-history-redo-stale-created: history redo followed by stale created echo
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"history-created-before-stale"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"history-created-before-stale"},"withStaleQuery":true}
```

### RT-024 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: dh-history-redo-session-refresh
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"history-session-before-stale"},"withStaleQuery":true} -->

- First seen: 2026-05-23T15:02:10.210Z
- Trace id: `dh-history-redo-session-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-history-redo-session-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-history-redo-session-refresh: history redo followed by session and refresh
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"history-session-before-stale"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"history-session-before-stale"},"withStaleQuery":true}
Domain trace: dh-history-redo-session-refresh
Action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"history-session-before-stale"},"withStaleQuery":true}
Trace:
domain trace dh-history-redo-session-refresh: history redo followed by session and refresh
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"history-session-before-stale"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"history-session-before-stale"},"withStaleQuery":true}
```

### RT-025 command-deleted node group:1779548531245 was resurrected
<!-- signature: command-deleted node group:<id> was resurrected
domain trace: dh-restore-history-redo-delayed-echo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-23T15:02:11.377Z
- Trace id: `dh-restore-history-redo-delayed-echo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-history-redo-delayed-echo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-restore-history-redo-delayed-echo: restored subtree history replay with delayed echo
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20}}
action 2: {"type":"outlinerUndo"}
Domain trace: dh-restore-history-redo-delayed-echo
Action 2: {"type":"outlinerUndo"}
Trace:
domain trace dh-restore-history-redo-delayed-echo: restored subtree history replay with delayed echo
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20}}
action 2: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:02:11.377Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","delayed-event","delete-rejection","focus","manual-refresh","native-close","nested-window","opener","partial-close","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restore-history-redo-delayed-echo","runs":12,"completedCorpus":true,"failures":4,"duplicateFailures":1,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:03:54.647Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","paired-echo","partial-close","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-refresh-delete-reject-window-after-relocation","runs":16,"completedCorpus":true,"failures":4,"duplicateFailures":4,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:04:59.078Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-update-race-focus-session-refresh","runs":19,"completedCorpus":true,"failures":4,"duplicateFailures":4,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:06:52.560Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-nested-opener-native-close-refresh","runs":23,"completedCorpus":true,"failures":4,"duplicateFailures":4,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:08:16.534Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-source-sibling-close-refresh-stale","runs":27,"completedCorpus":true,"failures":4,"duplicateFailures":4,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:10:04.555Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["known-finding"],"firstTraceId":"rt-active-race","lastTraceId":"rt-group-open-active-destination-tab-stale-created","runs":65,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-026 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-manual-stale-query-after-source-close
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"manual-stale-source-close-old"}} -->

- First seen: 2026-05-23T15:19:38.373Z
- Trace id: `dh-manual-stale-query-after-source-close`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-manual-stale-query-after-source-close pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-manual-stale-query-after-source-close: manual stale query after source window close
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"manual-stale-source-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"manual-stale-source-close-old"}}
Domain trace: dh-manual-stale-query-after-source-close
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"manual-stale-source-close-old"}}
Trace:
domain trace dh-manual-stale-query-after-source-close: manual stale query after source window close
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"manual-stale-source-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"manual-stale-source-close-old"}}
```

### RT-027 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: dh-history-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"history-manual-stale-old"}} -->

- First seen: 2026-05-23T15:19:39.531Z
- Trace id: `dh-history-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-history-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-history-manual-stale-query: history redo followed by manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"history-manual-stale-old"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"history-manual-stale-old"}}
Domain trace: dh-history-manual-stale-query
Action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"history-manual-stale-old"}}
Trace:
domain trace dh-history-manual-stale-query: history redo followed by manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"history-manual-stale-old"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"history-manual-stale-old"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:19:39.531Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-history-manual-stale-query","runs":30,"completedCorpus":true,"failures":6,"duplicateFailures":4,"newFindings":2} -->

### RT-028 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-repeated-relocation-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"repeated-manual-second-old"}} -->

- First seen: 2026-05-23T15:21:23.600Z
- Trace id: `dh-repeated-relocation-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-repeated-relocation-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-repeated-relocation-manual-stale-query: repeated relocation before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"repeated-manual-first-old"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"role":"lastMovedTab"},"captureStaleTabs":"repeated-manual-second-old"}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"repeated-manual-first-old"}}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"repeated-manual-second-old"}}
Domain trace: dh-repeated-relocation-manual-stale-query
Action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"repeated-manual-second-old"}}
Trace:
domain trace dh-repeated-relocation-manual-stale-query: repeated relocation before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"repeated-manual-first-old"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"role":"lastMovedTab"},"captureStaleTabs":"repeated-manual-second-old"}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"repeated-manual-first-old"}}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"repeated-manual-second-old"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:21:24.660Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restore-delete-manual-stale-query","runs":34,"completedCorpus":true,"failures":7,"duplicateFailures":6,"newFindings":1} -->

### RT-029 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-opener-source-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"opener-source-close-manual-old"}} -->

- First seen: 2026-05-23T15:23:25.834Z
- Trace id: `dh-opener-source-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-opener-source-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-opener-source-close-manual-stale-query: opener source closes before manual stale query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-manual-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"opener-manual-child"},"captureStaleTabs":"opener-source-close-manual-old"}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"opener-source-close-manual-old"}}
Domain trace: dh-opener-source-close-manual-stale-query
Action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"opener-source-close-manual-old"}}
Trace:
domain trace dh-opener-source-close-manual-stale-query: opener source closes before manual stale query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-manual-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"opener-manual-child"},"captureStaleTabs":"opener-source-close-manual-old"}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"opener-source-close-manual-old"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:23:25.836Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-opener-source-close-manual-stale-query","runs":38,"completedCorpus":true,"failures":8,"duplicateFailures":7,"newFindings":1} -->

### RT-030 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-group-source-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"group-source-close-manual-old"}} -->

- First seen: 2026-05-23T15:25:26.821Z
- Trace id: `dh-group-source-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-group-source-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-group-source-close-manual-stale-query: grouped source closes before manual stale query
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"group-source-close-manual-old"}}
Domain trace: dh-group-source-close-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"group-source-close-manual-old"}}
Trace:
domain trace dh-group-source-close-manual-stale-query: grouped source closes before manual stale query
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"group-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"group-source-close-manual-old"}}
```

### RT-031 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-top-level-source-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"top-level-source-close-manual-old"}} -->

- First seen: 2026-05-23T15:25:27.823Z
- Trace id: `dh-top-level-source-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-top-level-source-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-top-level-source-close-manual-stale-query: top-level promotion source closes before manual stale query
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"top-level-source-close-manual-old"}}
Domain trace: dh-top-level-source-close-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"top-level-source-close-manual-old"}}
Trace:
domain trace dh-top-level-source-close-manual-stale-query: top-level promotion source closes before manual stale query
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"top-level-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"top-level-source-close-manual-old"}}
```

### RT-032 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-created-race-source-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"created-race-source-close-manual-old"}} -->

- First seen: 2026-05-23T15:25:28.852Z
- Trace id: `dh-created-race-source-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-created-race-source-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-created-race-source-close-manual-stale-query: created race source closes before manual stale query
action 1: {"type":"raceWithOutlinerGroup","event":{"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"created-race-manual-tab"},"groupTab":{"tabId":1},"captureStaleTabs":"created-race-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"created-race-source-close-manual-old"}}
Domain trace: dh-created-race-source-close-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"created-race-source-close-manual-old"}}
Trace:
domain trace dh-created-race-source-close-manual-stale-query: created race source closes before manual stale query
action 1: {"type":"raceWithOutlinerGroup","event":{"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"created-race-manual-tab"},"groupTab":{"tabId":1},"captureStaleTabs":"created-race-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"created-race-source-close-manual-old"}}
```

### RT-033 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-activation-race-source-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"activation-race-source-close-manual-old"}} -->

- First seen: 2026-05-23T15:25:29.871Z
- Trace id: `dh-activation-race-source-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-activation-race-source-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-activation-race-source-close-manual-stale-query: activation race source closes before manual stale query
action 1: {"type":"raceWithOutlinerGroup","event":{"type":"activateTab","tab":{"tabId":2}},"groupTab":{"tabId":1},"captureStaleTabs":"activation-race-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"activation-race-source-close-manual-old"}}
Domain trace: dh-activation-race-source-close-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"activation-race-source-close-manual-old"}}
Trace:
domain trace dh-activation-race-source-close-manual-stale-query: activation race source closes before manual stale query
action 1: {"type":"raceWithOutlinerGroup","event":{"type":"activateTab","tab":{"tabId":2}},"groupTab":{"tabId":1},"captureStaleTabs":"activation-race-source-close-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"activation-race-source-close-manual-old"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:25:29.871Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-activation-race-source-close-manual-stale-query","runs":42,"completedCorpus":true,"failures":12,"duplicateFailures":8,"newFindings":4} -->

### RT-034 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-outliner-source-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-close-manual-old"}} -->

- First seen: 2026-05-23T15:27:18.212Z
- Trace id: `dh-outliner-source-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-outliner-source-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-outliner-source-close-manual-stale-query: outliner source close before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"outliner-source-close-manual-old"}
action 2: {"type":"outlinerCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-close-manual-old"}}
Domain trace: dh-outliner-source-close-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-close-manual-old"}}
Trace:
domain trace dh-outliner-source-close-manual-stale-query: outliner source close before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"outliner-source-close-manual-old"}
action 2: {"type":"outlinerCloseWindow","window":{"windowId":10}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-close-manual-old"}}
```

### RT-035 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-delete-reject-source-window-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"delete-source-window-manual-old"}} -->

- First seen: 2026-05-23T15:27:19.210Z
- Trace id: `dh-delete-reject-source-window-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-delete-reject-source-window-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-delete-reject-source-window-manual-stale-query: delete-reject source window before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"delete-source-window-manual-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"delete-source-window-manual-old"}}
Domain trace: dh-delete-reject-source-window-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"delete-source-window-manual-old"}}
Trace:
domain trace dh-delete-reject-source-window-manual-stale-query: delete-reject source window before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"delete-source-window-manual-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"delete-source-window-manual-old"}}
```

### RT-036 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-outliner-source-tab-close-manual-stale-query
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-tab-close-manual-old"}} -->

- First seen: 2026-05-23T15:27:20.230Z
- Trace id: `dh-outliner-source-tab-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-outliner-source-tab-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-outliner-source-tab-close-manual-stale-query: outliner source sibling close before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"outliner-source-tab-close-manual-old"}
action 2: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-tab-close-manual-old"}}
Domain trace: dh-outliner-source-tab-close-manual-stale-query
Action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-tab-close-manual-old"}}
Trace:
domain trace dh-outliner-source-tab-close-manual-stale-query: outliner source sibling close before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"outliner-source-tab-close-manual-old"}
action 2: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 3: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"outliner-source-tab-close-manual-old"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:27:20.231Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-outliner-source-tab-close-manual-stale-query","runs":45,"completedCorpus":true,"failures":15,"duplicateFailures":12,"newFindings":3} -->

### RT-037 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-relocated-tab-missing-manual-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}} -->

- First seen: 2026-05-23T15:29:21.703Z
- Trace id: `dh-relocated-tab-missing-manual-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-relocated-tab-missing-manual-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-relocated-tab-missing-manual-query: relocated tab missing from manual query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"missing-query-relocated-old"}
action 2: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
Domain trace: dh-relocated-tab-missing-manual-query
Action 2: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
Trace:
domain trace dh-relocated-tab-missing-manual-query: relocated tab missing from manual query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"missing-query-relocated-old"}
action 2: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
```

### RT-038 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-fresh-relocated-tab-missing-manual-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}} -->

- First seen: 2026-05-23T15:29:22.792Z
- Trace id: `dh-fresh-relocated-tab-missing-manual-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-fresh-relocated-tab-missing-manual-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-fresh-relocated-tab-missing-manual-query: fresh relocated tab missing from manual query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"fresh-missing-query-old"}
action 2: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"Fresh before missing query"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
Domain trace: dh-fresh-relocated-tab-missing-manual-query
Action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
Trace:
domain trace dh-fresh-relocated-tab-missing-manual-query: fresh relocated tab missing from manual query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"fresh-missing-query-old"}
action 2: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"Fresh before missing query"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
```

### RT-039 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-opener-child-missing-manual-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}} -->

- First seen: 2026-05-23T15:29:23.838Z
- Trace id: `dh-opener-child-missing-manual-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-opener-child-missing-manual-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled runtime trace fix pass.

```text
domain trace dh-opener-child-missing-manual-query: opener child missing from manual query after relocation
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"missing-query-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"missing-query-opener-child"},"captureStaleTabs":"opener-missing-query-old"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
Domain trace: dh-opener-child-missing-manual-query
Action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
Trace:
domain trace dh-opener-child-missing-manual-query: opener child missing from manual query after relocation
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"missing-query-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"missing-query-opener-child"},"captureStaleTabs":"opener-missing-query-old"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"role":"lastMovedTab"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T15:29:23.839Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-opener-child-missing-manual-query","runs":48,"completedCorpus":true,"failures":18,"duplicateFailures":15,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:31:33.422Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-focus-current-refresh-after-relocation","runs":51,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:33:09.652Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restore-current-refresh-after-delete","runs":54,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:34:46.614Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-delete-reject-current-refresh","runs":55,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:36:28.206Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-native-close-current-refresh","runs":57,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:38:07.606Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-destination-window-current-refresh","runs":58,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:39:39.527Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-source-sibling-current-refresh","runs":59,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:41:35.826Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-active-source-current-refresh","runs":61,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:43:15.454Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-race-active-current-refresh","runs":63,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:45:01.572Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-repeated-active-current-refresh","runs":64,"completedCorpus":true,"failures":18,"duplicateFailures":18,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T15:47:14.719Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["known-finding"],"firstTraceId":"rt-active-race","lastTraceId":"rt-group-open-active-destination-tab-stale-created","runs":65,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T16:36:39.057Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","created-event","delayed-event","delete-rejection","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-opener-child-missing-manual-query","runs":83,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-040 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-opener-history-missing-source-query
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T16:42:42.776Z
- Trace id: `dh-opener-history-missing-source-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-opener-history-missing-source-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-opener-history-missing-source-query: opener history replay with missing source query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-history-missing-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"opener-history-missing-child"},"captureStaleTabs":"opener-history-missing-old"}
action 3: {"type":"outlinerUndo"}
action 4: {"type":"outlinerRedo"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-opener-history-missing-source-query
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-opener-history-missing-source-query: opener history replay with missing source query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-history-missing-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"opener-history-missing-child"},"captureStaleTabs":"opener-history-missing-old"}
action 3: {"type":"outlinerUndo"}
action 4: {"type":"outlinerRedo"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

### RT-041 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restore-history-missing-window-query
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"focusedWindow"}} -->

- First seen: 2026-05-23T16:42:45.699Z
- Trace id: `dh-restore-history-missing-window-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-history-missing-window-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-restore-history-missing-window-query: restore history replay with missing window query
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-history-missing-window"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"focusedWindow"}}
Domain trace: dh-restore-history-missing-window-query
Action 3: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"focusedWindow"}}
Trace:
domain trace dh-restore-history-missing-window-query: restore history replay with missing window query
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-history-missing-window"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"focusedWindow"}}
```

### RT-042 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restore-history-reordered-query
action: {"type":"manualRefreshWithReorderedQuery","window":{"role":"focusedWindow"},"order":"rotateRight"} -->

- First seen: 2026-05-23T16:42:46.675Z
- Trace id: `dh-restore-history-reordered-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-history-reordered-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-restore-history-reordered-query: restore history replay with reordered query
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-history-reorder"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"openTab","window":{"role":"focusedWindow"},"active":false,"captureTab":"restore-history-reorder-extra"}
action 4: {"type":"manualRefreshWithReorderedQuery","window":{"role":"focusedWindow"},"order":"rotateRight"}
Domain trace: dh-restore-history-reordered-query
Action 4: {"type":"manualRefreshWithReorderedQuery","window":{"role":"focusedWindow"},"order":"rotateRight"}
Trace:
domain trace dh-restore-history-reordered-query: restore history replay with reordered query
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-history-reorder"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"openTab","window":{"role":"focusedWindow"},"active":false,"captureTab":"restore-history-reorder-extra"}
action 4: {"type":"manualRefreshWithReorderedQuery","window":{"role":"focusedWindow"},"order":"rotateRight"}
```

### RT-043 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restore-history-redo-partial-query
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"firstRuntimeWindow"}} -->

- First seen: 2026-05-23T16:42:47.663Z
- Trace id: `dh-restore-history-redo-partial-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-history-redo-partial-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-restore-history-redo-partial-query: restore history redo with partial query
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-history-redo-partial"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"firstRuntimeWindow"}}
Domain trace: dh-restore-history-redo-partial-query
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"firstRuntimeWindow"}}
Trace:
domain trace dh-restore-history-redo-partial-query: restore history redo with partial query
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-history-redo-partial"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"firstRuntimeWindow"}}
```

### RT-044 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-window-close-destination-tabs-only
action: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"} -->

- First seen: 2026-05-23T16:42:49.597Z
- Trace id: `dh-window-close-destination-tabs-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-window-close-destination-tabs-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-window-close-destination-tabs-only: destination window close emits tabs only
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"window-close-destination-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
Domain trace: dh-window-close-destination-tabs-only
Action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
Trace:
domain trace dh-window-close-destination-tabs-only: destination window close emits tabs only
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"window-close-destination-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
```

### RT-045 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-window-close-nested-window-only
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-nested-window-only-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T16:42:50.595Z
- Trace id: `dh-window-close-nested-window-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-window-close-nested-window-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-window-close-nested-window-only: nested window close emits window only
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"window-close-nested-window-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"manualRefresh"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-nested-window-only-old"},"withStaleQuery":true}
Domain trace: dh-window-close-nested-window-only
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-nested-window-only-old"},"withStaleQuery":true}
Trace:
domain trace dh-window-close-nested-window-only: nested window close emits window only
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"window-close-nested-window-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"manualRefresh"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-nested-window-only-old"},"withStaleQuery":true}
```

### RT-046 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-window-close-source-tabs-only
action: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"} -->

- First seen: 2026-05-23T16:42:51.581Z
- Trace id: `dh-window-close-source-tabs-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-window-close-source-tabs-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-window-close-source-tabs-only: source window close emits tabs only
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"window-close-source-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
Domain trace: dh-window-close-source-tabs-only
Action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
Trace:
domain trace dh-window-close-source-tabs-only: source window close emits tabs only
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"window-close-source-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
```

### RT-047 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-query-missing-source-window-after-relocation
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T16:42:52.577Z
- Trace id: `dh-query-missing-source-window-after-relocation`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-query-missing-source-window-after-relocation pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-query-missing-source-window-after-relocation: query omits source window after relocation
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"query-missing-source-window-old"}
action 2: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-query-missing-source-window-after-relocation
Action 2: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-query-missing-source-window-after-relocation: query omits source window after relocation
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"query-missing-source-window-old"}
action 2: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

### RT-048 domain create window rejected after completion
<!-- signature: domain create window rejected after completion
domain trace: dh-relocation-create-reject-direct
action: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"tabId":1},"captureStaleTabs":"relocation-create-reject-direct-old"} -->

- First seen: 2026-05-23T16:42:55.605Z
- Trace id: `dh-relocation-create-reject-direct`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-relocation-create-reject-direct pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-relocation-create-reject-direct: relocation create rejects after moving tab
action 1: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"tabId":1},"captureStaleTabs":"relocation-create-reject-direct-old"}
```

### RT-049 domain create window rejected after completion
<!-- signature: domain create window rejected after completion
domain trace: dh-relocation-create-reject-opener
action: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"relocation-create-reject-opener-child"},"captureStaleTabs":"relocation-create-reject-opener-old"} -->

- First seen: 2026-05-23T16:42:56.587Z
- Trace id: `dh-relocation-create-reject-opener`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-relocation-create-reject-opener pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-relocation-create-reject-opener: opener relocation create rejects after moving tab
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"relocation-create-reject-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"relocation-create-reject-opener-child"},"captureStaleTabs":"relocation-create-reject-opener-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T16:42:56.588Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-relocation-create-reject-opener","runs":61,"completedCorpus":true,"failures":10,"duplicateFailures":0,"newFindings":10} -->

### RT-050 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-focus-session-missing-window-query
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T16:45:27.479Z
- Trace id: `dh-focus-session-missing-window-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-focus-session-missing-window-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-focus-session-missing-window-query: focus session refresh with missing focused window query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"focus-session-missing-window-extra"}
action 2: {"type":"focusWindow","window":{"windowId":10}}
action 3: {"type":"activateTab","tab":{"capture":"focus-session-missing-window-extra"}}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-focus-session-missing-window-query
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-focus-session-missing-window-query: focus session refresh with missing focused window query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"focus-session-missing-window-extra"}
action 2: {"type":"focusWindow","window":{"windowId":10}}
action 3: {"type":"activateTab","tab":{"capture":"focus-session-missing-window-extra"}}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T16:45:27.481Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-focus-session-missing-window-query","runs":67,"completedCorpus":true,"failures":11,"duplicateFailures":10,"newFindings":1} -->

### RT-051 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-focus-session-missing-background-window
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}} -->

- First seen: 2026-05-23T16:47:44.173Z
- Trace id: `dh-focus-session-missing-background-window`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-focus-session-missing-background-window pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-focus-session-missing-background-window: focus session refresh with missing background window
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"focus-session-background-extra"}
action 2: {"type":"focusWindow","window":{"windowId":10}}
action 3: {"type":"activateTab","tab":{"tabId":2}}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}}
Domain trace: dh-focus-session-missing-background-window
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}}
Trace:
domain trace dh-focus-session-missing-background-window: focus session refresh with missing background window
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"focus-session-background-extra"}
action 2: {"type":"focusWindow","window":{"windowId":10}}
action 3: {"type":"activateTab","tab":{"tabId":2}}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}}
```

### RT-052 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-opener-focus-session-missing-window
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T16:47:46.551Z
- Trace id: `dh-opener-focus-session-missing-window`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-opener-focus-session-missing-window pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-opener-focus-session-missing-window: opener focus session omits source window
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-focus-session-child"}
action 2: {"type":"focusWindow","window":{"windowId":10}}
action 3: {"type":"activateTab","tab":{"capture":"opener-focus-session-child"}}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-opener-focus-session-missing-window
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-opener-focus-session-missing-window: opener focus session omits source window
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-focus-session-child"}
action 2: {"type":"focusWindow","window":{"windowId":10}}
action 3: {"type":"activateTab","tab":{"capture":"opener-focus-session-child"}}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

### RT-053 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-window-close-opener-tabs-only
action: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"} -->

- First seen: 2026-05-23T16:47:47.635Z
- Trace id: `dh-window-close-opener-tabs-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-window-close-opener-tabs-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-window-close-opener-tabs-only: opener source window close emits tabs only
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"window-close-opener-tabs-only-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"window-close-opener-tabs-only-child"},"captureStaleTabs":"window-close-opener-tabs-only-old"}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
Domain trace: dh-window-close-opener-tabs-only
Action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
Trace:
domain trace dh-window-close-opener-tabs-only: opener source window close emits tabs only
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"window-close-opener-tabs-only-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"window-close-opener-tabs-only-child"},"captureStaleTabs":"window-close-opener-tabs-only-old"}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T16:47:47.636Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-window-close-opener-tabs-only","runs":71,"completedCorpus":true,"failures":14,"duplicateFailures":11,"newFindings":3} -->

### RT-054 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-window-close-destination-window-only
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-destination-window-only-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T16:49:59.450Z
- Trace id: `dh-window-close-destination-window-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-window-close-destination-window-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-window-close-destination-window-only: destination window close emits window only
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"window-close-destination-window-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"manualRefresh"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-destination-window-only-old"},"withStaleQuery":true}
Domain trace: dh-window-close-destination-window-only
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-destination-window-only-old"},"withStaleQuery":true}
Trace:
domain trace dh-window-close-destination-window-only: destination window close emits window only
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"window-close-destination-window-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"manualRefresh"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"window-close-destination-window-only-old"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T16:50:02.618Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-session-reordered-both-windows","runs":75,"completedCorpus":true,"failures":15,"duplicateFailures":14,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T16:52:40.171Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-session-reordered-both-windows","runs":75,"completedCorpus":true,"failures":15,"duplicateFailures":15,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T16:54:51.198Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-destination-window-first-session-refresh","runs":78,"completedCorpus":true,"failures":15,"duplicateFailures":15,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T16:57:35.819Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-destination-window-first-session-refresh","runs":78,"completedCorpus":true,"failures":15,"duplicateFailures":15,"newFindings":0} -->

### RT-055 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-nested-tabs-only-session-refresh
action: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"} -->

- First seen: 2026-05-23T17:01:38.588Z
- Trace id: `dh-nested-tabs-only-session-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-nested-tabs-only-session-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-nested-tabs-only-session-refresh: nested tabs-only close followed by session refresh
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"nested-tabs-only-session-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
Domain trace: dh-nested-tabs-only-session-refresh
Action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
Trace:
domain trace dh-nested-tabs-only-session-refresh: nested tabs-only close followed by session refresh
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"nested-tabs-only-session-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
```

### RT-056 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restore-history-source-reordered-session
action: {"type":"manualRefreshWithReorderedQuery","window":{"windowId":10},"order":"reverse"} -->

- First seen: 2026-05-23T17:01:39.689Z
- Trace id: `dh-restore-history-source-reordered-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-history-source-reordered-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-restore-history-source-reordered-session: restore history with source reordered after session
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-source-reordered-session"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restore-source-reordered-extra"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithReorderedQuery","window":{"windowId":10},"order":"reverse"}
Domain trace: dh-restore-history-source-reordered-session
Action 5: {"type":"manualRefreshWithReorderedQuery","window":{"windowId":10},"order":"reverse"}
Trace:
domain trace dh-restore-history-source-reordered-session: restore history with source reordered after session
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-source-reordered-session"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restore-source-reordered-extra"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithReorderedQuery","window":{"windowId":10},"order":"reverse"}
```

### RT-057 domain create window rejected after completion
<!-- signature: domain create window rejected after completion
domain trace: dh-relocation-reject-after-reordered-query
action: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"reject-reordered-query-tab"},"captureStaleTabs":"reject-reordered-query-old"} -->

- First seen: 2026-05-23T17:01:40.937Z
- Trace id: `dh-relocation-reject-after-reordered-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-relocation-reject-after-reordered-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-relocation-reject-after-reordered-query: relocation create rejects after reordered query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"reject-reordered-query-tab"}
action 2: {"type":"manualRefreshWithReorderedQuery","window":{"windowId":10},"order":"rotateRight"}
action 3: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"reject-reordered-query-tab"},"captureStaleTabs":"reject-reordered-query-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T17:01:42.029Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-focus-session-destination-reordered","runs":82,"completedCorpus":true,"failures":18,"duplicateFailures":15,"newFindings":3} -->

### RT-058 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-focus-relocation-missing-background-query
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}} -->

- First seen: 2026-05-23T17:04:44.168Z
- Trace id: `dh-focus-relocation-missing-background-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-focus-relocation-missing-background-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-focus-relocation-missing-background-query: focus relocation with missing background query
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"focus-relocation-background-extra"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"focus-relocation-missing-background-old"}
action 3: {"type":"focusWindow","window":{"role":"lastOpenedWindow"}}
action 4: {"type":"activateTab","tab":{"role":"lastMovedTab"}}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}}
Domain trace: dh-focus-relocation-missing-background-query
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}}
Trace:
domain trace dh-focus-relocation-missing-background-query: focus relocation with missing background query
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"focus-relocation-background-extra"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"focus-relocation-missing-background-old"}
action 3: {"type":"focusWindow","window":{"role":"lastOpenedWindow"}}
action 4: {"type":"activateTab","tab":{"role":"lastMovedTab"}}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":20}}
```

### RT-059 domain create window rejected after completion
<!-- signature: domain create window rejected after completion
domain trace: dh-relocation-reject-after-focus-session
action: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"reject-focus-session-tab"},"captureStaleTabs":"reject-focus-session-old"} -->

- First seen: 2026-05-23T17:04:46.374Z
- Trace id: `dh-relocation-reject-after-focus-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-relocation-reject-after-focus-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-relocation-reject-after-focus-session: relocation create rejects after focus session
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"reject-focus-session-tab"}
action 2: {"type":"focusWindow","window":{"windowId":20}}
action 3: {"type":"sessionChanged"}
action 4: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"reject-focus-session-tab"},"captureStaleTabs":"reject-focus-session-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T17:04:46.375Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-relocation-reject-after-focus-session","runs":87,"completedCorpus":true,"failures":20,"duplicateFailures":18,"newFindings":2} -->

### RT-060 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restore-history-missing-source-session
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T17:07:19.387Z
- Trace id: `dh-restore-history-missing-source-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-history-missing-source-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-restore-history-missing-source-session: restore history with missing source after session
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-missing-source-session"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restore-missing-source-extra"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-restore-history-missing-source-session
Action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-restore-history-missing-source-session: restore history with missing source after session
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-missing-source-session"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restore-missing-source-extra"}
action 4: {"type":"sessionChanged"}
action 5: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T17:07:20.417Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-focus-session-reordered-background-query","runs":90,"completedCorpus":true,"failures":21,"duplicateFailures":20,"newFindings":1} -->

### RT-061 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-destination-default-close-missing-source-query
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T17:09:46.158Z
- Trace id: `dh-destination-default-close-missing-source-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-destination-default-close-missing-source-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-destination-default-close-missing-source-query: destination default close with missing source query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"destination-default-missing-source-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-destination-default-close-missing-source-query
Action 3: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-destination-default-close-missing-source-query: destination default close with missing source query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"destination-default-missing-source-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T17:09:46.159Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-destination-default-close-missing-source-query","runs":92,"completedCorpus":true,"failures":22,"duplicateFailures":21,"newFindings":1} -->

### RT-062 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restore-redo-missing-source-session
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}} -->

- First seen: 2026-05-23T17:12:07.935Z
- Trace id: `dh-restore-redo-missing-source-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-redo-missing-source-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in principled coverage-first runtime trace fix pass.

```text
domain trace dh-restore-redo-missing-source-session: restore redo with missing source after session
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-redo-missing-source"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restore-redo-missing-source-extra"}
action 5: {"type":"sessionChanged"}
action 6: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Domain trace: dh-restore-redo-missing-source-session
Action 6: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
Trace:
domain trace dh-restore-redo-missing-source-session: restore redo with missing source after session
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restore-redo-missing-source"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restore-redo-missing-source-extra"}
action 5: {"type":"sessionChanged"}
action 6: {"type":"manualRefreshWithMissingWindowQuery","window":{"windowId":10}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T17:12:08.935Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-destination-default-close-reordered-source-query","runs":94,"completedCorpus":true,"failures":23,"duplicateFailures":22,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:14:44.738Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-opener-tab-close-reordered-session","runs":97,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:16:54.221Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-opener-tab-close-reordered-session","runs":97,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:19:30.320Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-opener-tab-close-reordered-session","runs":97,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:21:58.956Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-session-only-tab-close-reordered-source","runs":99,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:23:50.417Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-session-only-tab-close-reordered-source","runs":99,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:26:19.003Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-session-only-tab-close-reordered-source","runs":99,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:28:45.801Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":101,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:30:34.159Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":101,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:33:58.734Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":101,"completedCorpus":true,"failures":23,"duplicateFailures":23,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T17:36:48.653Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","created-event","delayed-event","delete-rejection","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-opener-child-missing-manual-query","runs":83,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T18:07:39.448Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restore-redo-missing-source-session","runs":106,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T18:09:03.768Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":78,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T18:46:37.043Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restore-redo-missing-source-session","runs":106,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T18:48:11.822Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":78,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T19:27:58.101Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restore-redo-missing-source-session","runs":106,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T19:29:30.408Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":78,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T19:45:45.212Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restore-redo-missing-source-session","runs":106,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T19:47:12.357Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","reparenting","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-flush-stale-created-destination-reordered","runs":78,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-063 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-destination-close-stale-old
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-close-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:49:22.554Z
- Trace id: `dh-restart-destination-close-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-destination-close-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-destination-close-stale-old: restart destination close stale old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-close-old"},"withStaleQuery":true}
Domain trace: dh-restart-destination-close-stale-old
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-close-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-destination-close-stale-old: restart destination close stale old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-close-old"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T19:49:32.360Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-nested-restart-missing-background","runs":90,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-064 expected closed node window:22 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-restore-native-close-after-restart
action: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedOnly"} -->

- First seen: 2026-05-23T19:52:12.257Z
- Trace id: `dh-restore-native-close-after-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restore-native-close-after-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restore-native-close-after-restart: restore native close after restart
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-native-close"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedOnly"}
Domain trace: dh-restore-native-close-after-restart
Action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedOnly"}
Trace:
domain trace dh-restore-native-close-after-restart: restore native close after restart
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-native-close"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T19:52:15.351Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-nested-restart-missing-background","runs":90,"completedCorpus":true,"failures":2,"duplicateFailures":1,"newFindings":1} -->

### RT-065 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-destination-tabs-only-stale-created
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-destination-tabs-only-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:55:24.127Z
- Trace id: `dh-restart-destination-tabs-only-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-destination-tabs-only-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-destination-tabs-only-stale-created: restart destination tabs only stale created
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-destination-tabs-only-old"},"withStaleQuery":true}
Domain trace: dh-restart-destination-tabs-only-stale-created
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-destination-tabs-only-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-destination-tabs-only-stale-created: restart destination tabs only stale created
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-destination-tabs-only-old"},"withStaleQuery":true}
```

### RT-066 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-destination-window-first-paired-old
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-window-first-old"},"withStaleQuery":false} -->

- First seen: 2026-05-23T19:55:25.178Z
- Trace id: `dh-restart-destination-window-first-paired-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-destination-window-first-paired-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-destination-window-first-paired-old: restart destination window first paired old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-window-first-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedThenTabsRemoved"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-window-first-old"},"withStaleQuery":false}
Domain trace: dh-restart-destination-window-first-paired-old
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-window-first-old"},"withStaleQuery":false}
Trace:
domain trace dh-restart-destination-window-first-paired-old: restart destination window first paired old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-window-first-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedThenTabsRemoved"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-destination-window-first-old"},"withStaleQuery":false}
```

### RT-067 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-relocated-tab-session-only-stale
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-relocated-session-only-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:55:26.204Z
- Trace id: `dh-restart-relocated-tab-session-only-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-relocated-tab-session-only-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-relocated-tab-session-only-stale: restart relocated tab session only stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-relocated-session-only-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-relocated-session-only-old"},"withStaleQuery":true}
Domain trace: dh-restart-relocated-tab-session-only-stale
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-relocated-session-only-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-relocated-tab-session-only-stale: restart relocated tab session only stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-relocated-session-only-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-relocated-session-only-old"},"withStaleQuery":true}
```

### RT-068 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-relocated-tab-removed-only-stale
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-relocated-tab-only-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:55:27.232Z
- Trace id: `dh-restart-relocated-tab-removed-only-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-relocated-tab-removed-only-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-relocated-tab-removed-only-stale: restart relocated tab removed only stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-relocated-tab-only-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"tabRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-relocated-tab-only-old"},"withStaleQuery":true}
Domain trace: dh-restart-relocated-tab-removed-only-stale
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-relocated-tab-only-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-relocated-tab-removed-only-stale: restart relocated tab removed only stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-relocated-tab-only-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"tabRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-relocated-tab-only-old"},"withStaleQuery":true}
```

### RT-069 expected closed node window:22 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-restart-restore-native-tabs-only-stale
action: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedOnly"} -->

- First seen: 2026-05-23T19:55:28.310Z
- Trace id: `dh-restart-restore-native-tabs-only-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-restore-native-tabs-only-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-restore-native-tabs-only-stale: restart restore native tabs only stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-tabs-only"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedOnly"}
Domain trace: dh-restart-restore-native-tabs-only-stale
Action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedOnly"}
Trace:
domain trace dh-restart-restore-native-tabs-only-stale: restart restore native tabs only stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-tabs-only"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedOnly"}
```

### RT-070 expected closed node window:22 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-restart-restore-native-window-first-stale
action: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedThenTabsRemoved"} -->

- First seen: 2026-05-23T19:55:29.371Z
- Trace id: `dh-restart-restore-native-window-first-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-restore-native-window-first-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-restore-native-window-first-stale: restart restore native window first stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-window-first"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedThenTabsRemoved"}
Domain trace: dh-restart-restore-native-window-first-stale
Action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedThenTabsRemoved"}
Trace:
domain trace dh-restart-restore-native-window-first-stale: restart restore native window first stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-window-first"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"windowRemovedThenTabsRemoved"}
```

### RT-071 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-reject-destination-close-stale-old
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-reject-destination-close-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:55:30.451Z
- Trace id: `dh-restart-reject-destination-close-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-reject-destination-close-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-reject-destination-close-stale-old: restart reject destination close stale old
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restart-reject-destination-close-tab"}
action 2: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"restart-reject-destination-close-tab"},"captureStaleTabs":"restart-reject-destination-close-old"}
action 3: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 4: {"type":"restartBackground"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-reject-destination-close-old"},"withStaleQuery":true}
Domain trace: dh-restart-reject-destination-close-stale-old
Action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-reject-destination-close-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-reject-destination-close-stale-old: restart reject destination close stale old
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restart-reject-destination-close-tab"}
action 2: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"restart-reject-destination-close-tab"},"captureStaleTabs":"restart-reject-destination-close-old"}
action 3: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 4: {"type":"restartBackground"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-reject-destination-close-old"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T19:55:31.474Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-reject-destination-missing-query","runs":98,"completedCorpus":true,"failures":9,"duplicateFailures":2,"newFindings":7} -->

### RT-072 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-group-destination-close-stale-old
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-group-destination-close-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:58:37.691Z
- Trace id: `dh-restart-group-destination-close-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-group-destination-close-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-group-destination-close-stale-old: restart group destination close stale old
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"restart-group-destination-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-group-destination-close-old"},"withStaleQuery":true}
Domain trace: dh-restart-group-destination-close-stale-old
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-group-destination-close-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-group-destination-close-stale-old: restart group destination close stale old
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"restart-group-destination-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-group-destination-close-old"},"withStaleQuery":true}
```

### RT-073 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-top-level-destination-close-stale-old
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-top-level-destination-close-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:58:38.746Z
- Trace id: `dh-restart-top-level-destination-close-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-top-level-destination-close-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-top-level-destination-close-stale-old: restart top level destination close stale old
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"restart-top-level-destination-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-top-level-destination-close-old"},"withStaleQuery":true}
Domain trace: dh-restart-top-level-destination-close-stale-old
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-top-level-destination-close-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-top-level-destination-close-stale-old: restart top level destination close stale old
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"restart-top-level-destination-close-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-top-level-destination-close-old"},"withStaleQuery":true}
```

### RT-074 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-outliner-close-destination-stale-old
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-outliner-close-destination-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:58:39.812Z
- Trace id: `dh-restart-outliner-close-destination-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-outliner-close-destination-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-outliner-close-destination-stale-old: restart outliner close destination stale old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-outliner-close-destination-old"}
action 2: {"type":"outlinerCloseWindow","window":{"role":"lastOpenedWindow"}}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-outliner-close-destination-old"},"withStaleQuery":true}
Domain trace: dh-restart-outliner-close-destination-stale-old
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-outliner-close-destination-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-outliner-close-destination-stale-old: restart outliner close destination stale old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-outliner-close-destination-old"}
action 2: {"type":"outlinerCloseWindow","window":{"role":"lastOpenedWindow"}}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"restart-outliner-close-destination-old"},"withStaleQuery":true}
```

### RT-075 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-outliner-close-tab-stale-old
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-outliner-close-tab-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T19:58:40.846Z
- Trace id: `dh-restart-outliner-close-tab-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-outliner-close-tab-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-outliner-close-tab-stale-old: restart outliner close tab stale old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-outliner-close-tab-old"}
action 2: {"type":"outlinerCloseTab","tab":{"role":"lastMovedTab"}}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-outliner-close-tab-old"},"withStaleQuery":true}
Domain trace: dh-restart-outliner-close-tab-stale-old
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-outliner-close-tab-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-outliner-close-tab-stale-old: restart outliner close tab stale old
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-outliner-close-tab-old"}
action 2: {"type":"outlinerCloseTab","tab":{"role":"lastMovedTab"}}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-outliner-close-tab-old"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T19:58:41.879Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-focus-session-source-window-only-old","runs":106,"completedCorpus":true,"failures":13,"duplicateFailures":9,"newFindings":4} -->

### RT-076 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-destination-window-only-manual-stale
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-window-only-manual-old"}} -->

- First seen: 2026-05-23T20:02:02.303Z
- Trace id: `dh-restart-destination-window-only-manual-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-destination-window-only-manual-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-destination-window-only-manual-stale: restart destination window only manual stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-window-only-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-window-only-manual-old"}}
Domain trace: dh-restart-destination-window-only-manual-stale
Action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-window-only-manual-old"}}
Trace:
domain trace dh-restart-destination-window-only-manual-stale: restart destination window only manual stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-window-only-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-window-only-manual-old"}}
```

### RT-077 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-destination-tabs-only-manual-stale
action: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-tabs-only-manual-old"}} -->

- First seen: 2026-05-23T20:02:03.611Z
- Trace id: `dh-restart-destination-tabs-only-manual-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-destination-tabs-only-manual-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-destination-tabs-only-manual-stale: restart destination tabs only manual stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-tabs-only-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-tabs-only-manual-old"}}
Domain trace: dh-restart-destination-tabs-only-manual-stale
Action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-tabs-only-manual-old"}}
Trace:
domain trace dh-restart-destination-tabs-only-manual-stale: restart destination tabs only manual stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"restart-destination-tabs-only-manual-old"}
action 2: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"manualRefreshWithStaleQuery","staleTab":{"capture":"restart-destination-tabs-only-manual-old"}}
```

### RT-078 expected closed node window:22 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-restart-restore-native-default-stale
action: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedThenWindowRemoved"} -->

- First seen: 2026-05-23T20:02:04.896Z
- Trace id: `dh-restart-restore-native-default-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-restore-native-default-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-restore-native-default-stale: restart restore native default stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-default"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedThenWindowRemoved"}
Domain trace: dh-restart-restore-native-default-stale
Action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedThenWindowRemoved"}
Trace:
domain trace dh-restart-restore-native-default-stale: restart restore native default stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-default"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseWindow","window":{"role":"focusedWindow"},"order":"tabsRemovedThenWindowRemoved"}
```

### RT-079 expected closed node window:22 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-restart-restore-native-tab-close-stale
action: {"type":"nativeCloseTab","tab":{"inWindow":{"role":"focusedWindow"}},"order":"tabRemovedThenSessionChanged"} -->

- First seen: 2026-05-23T20:02:06.073Z
- Trace id: `dh-restart-restore-native-tab-close-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-restore-native-tab-close-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-restore-native-tab-close-stale: restart restore native tab close stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-tab-close"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseTab","tab":{"inWindow":{"role":"focusedWindow"}},"order":"tabRemovedThenSessionChanged"}
Domain trace: dh-restart-restore-native-tab-close-stale
Action 4: {"type":"nativeCloseTab","tab":{"inWindow":{"role":"focusedWindow"}},"order":"tabRemovedThenSessionChanged"}
Trace:
domain trace dh-restart-restore-native-tab-close-stale: restart restore native tab close stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-tab-close"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"nativeCloseTab","tab":{"inWindow":{"role":"focusedWindow"}},"order":"tabRemovedThenSessionChanged"}
```

### RT-080 expected closed node window:22 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-restart-restore-outliner-close-window-stale
action: {"type":"outlinerCloseWindow","window":{"role":"focusedWindow"}} -->

- First seen: 2026-05-23T20:02:07.315Z
- Trace id: `dh-restart-restore-outliner-close-window-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-restore-outliner-close-window-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-restore-outliner-close-window-stale: restart restore outliner close window stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-outliner-close-window"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerCloseWindow","window":{"role":"focusedWindow"}}
Domain trace: dh-restart-restore-outliner-close-window-stale
Action 4: {"type":"outlinerCloseWindow","window":{"role":"focusedWindow"}}
Trace:
domain trace dh-restart-restore-outliner-close-window-stale: restart restore outliner close window stale
action 1: {"type":"outlinerRestoreDeleteWindowDelayedEvent","window":{"windowId":20},"captureStaleTabs":"restart-restore-outliner-close-window"}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerCloseWindow","window":{"role":"focusedWindow"}}
```

### RT-081 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-delete-reject-destination-close-created
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-reject-destination-close-created-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T20:02:08.481Z
- Trace id: `dh-restart-delete-reject-destination-close-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-delete-reject-destination-close-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-delete-reject-destination-close-created: restart delete reject destination close created
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restart-reject-destination-close-created-tab"}
action 2: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"restart-reject-destination-close-created-tab"},"captureStaleTabs":"restart-reject-destination-close-created-old"}
action 3: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
action 4: {"type":"restartBackground"}
action 5: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-reject-destination-close-created-old"},"withStaleQuery":true}
Domain trace: dh-restart-delete-reject-destination-close-created
Action 5: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-reject-destination-close-created-old"},"withStaleQuery":true}
Trace:
domain trace dh-restart-delete-reject-destination-close-created: restart delete reject destination close created
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restart-reject-destination-close-created-tab"}
action 2: {"type":"outlinerMoveTabCommandToNewWindowRejectingCreate","tab":{"capture":"restart-reject-destination-close-created-tab"},"captureStaleTabs":"restart-reject-destination-close-created-old"}
action 3: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"tabsRemovedOnly"}
action 4: {"type":"restartBackground"}
action 5: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"restart-reject-destination-close-created-old"},"withStaleQuery":true}
```

### RT-082 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-opener-chain-restart-destination-close
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"opener-chain-destination-close-old"},"withStaleQuery":true} -->

- First seen: 2026-05-23T20:02:09.733Z
- Trace id: `dh-opener-chain-restart-destination-close`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-opener-chain-restart-destination-close pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-opener-chain-restart-destination-close: opener chain restart destination close
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-chain-destination-close-child"}
action 2: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"capture":"opener-chain-destination-close-child"},"captureTab":"opener-chain-destination-close-grandchild"}
action 3: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"opener-chain-destination-close-grandchild"},"captureStaleTabs":"opener-chain-destination-close-old"}
action 4: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 5: {"type":"restartBackground"}
action 6: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"opener-chain-destination-close-old"},"withStaleQuery":true}
Domain trace: dh-opener-chain-restart-destination-close
Action 6: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"opener-chain-destination-close-old"},"withStaleQuery":true}
Trace:
domain trace dh-opener-chain-restart-destination-close: opener chain restart destination close
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"opener-chain-destination-close-child"}
action 2: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"capture":"opener-chain-destination-close-child"},"captureTab":"opener-chain-destination-close-grandchild"}
action 3: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"opener-chain-destination-close-grandchild"},"captureStaleTabs":"opener-chain-destination-close-old"}
action 4: {"type":"nativeCloseWindow","window":{"role":"lastOpenedWindow"},"order":"windowRemovedOnly"}
action 5: {"type":"restartBackground"}
action 6: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"opener-chain-destination-close-old"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T20:02:09.733Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-opener-chain-restart-destination-close","runs":113,"completedCorpus":true,"failures":20,"duplicateFailures":13,"newFindings":7} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T20:05:29.168Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-focus-current-window-reordered","runs":119,"completedCorpus":true,"failures":20,"duplicateFailures":20,"newFindings":0} -->

### RT-083 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: dh-restart-focus-command-no-relocation
action: {"type":"outlinerFocusTab","tab":{"tabId":2}} -->

- First seen: 2026-05-23T20:08:40.526Z
- Trace id: `dh-restart-focus-command-no-relocation`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-focus-command-no-relocation pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-focus-command-no-relocation: restart focus command no relocation
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Domain trace: dh-restart-focus-command-no-relocation
Action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Trace:
domain trace dh-restart-focus-command-no-relocation: restart focus command no relocation
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T20:08:40.528Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-focus-command-no-relocation","runs":125,"completedCorpus":true,"failures":21,"duplicateFailures":20,"newFindings":1} -->

### RT-084 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: dh-restart-focus-command-complete-refresh
action: {"type":"outlinerFocusTab","tab":{"tabId":2}} -->

- First seen: 2026-05-23T20:11:36.669Z
- Trace id: `dh-restart-focus-command-complete-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-focus-command-complete-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-focus-command-complete-refresh: restart focus command complete refresh
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Domain trace: dh-restart-focus-command-complete-refresh
Action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Trace:
domain trace dh-restart-focus-command-complete-refresh: restart focus command complete refresh
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
```

### RT-085 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: dh-restart-focus-command-session-activation
action: {"type":"outlinerFocusTab","tab":{"tabId":2}} -->

- First seen: 2026-05-23T20:11:37.715Z
- Trace id: `dh-restart-focus-command-session-activation`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-focus-command-session-activation pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-focus-command-session-activation: restart focus command session activation
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Domain trace: dh-restart-focus-command-session-activation
Action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Trace:
domain trace dh-restart-focus-command-session-activation: restart focus command session activation
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
```

### RT-086 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: dh-restart-focus-command-missing-focused-tab
action: {"type":"outlinerFocusTab","tab":{"tabId":2}} -->

- First seen: 2026-05-23T20:11:39.837Z
- Trace id: `dh-restart-focus-command-missing-focused-tab`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-focus-command-missing-focused-tab pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-focus-command-missing-focused-tab: restart focus command missing focused tab
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Domain trace: dh-restart-focus-command-missing-focused-tab
Action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
Trace:
domain trace dh-restart-focus-command-missing-focused-tab: restart focus command missing focused tab
action 1: {"type":"outlinerFocusTab","tab":{"tabId":2}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T20:11:39.838Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-focus-command-missing-focused-tab","runs":129,"completedCorpus":true,"failures":24,"duplicateFailures":21,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T20:14:54.010Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-session-only-opened-tab-refresh","runs":134,"completedCorpus":true,"failures":24,"duplicateFailures":24,"newFindings":0} -->

### RT-087 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-missing-opened-tab-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opened-tab"}} -->

- First seen: 2026-05-23T20:18:05.688Z
- Trace id: `dh-restart-missing-opened-tab-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-missing-opened-tab-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-missing-opened-tab-query: restart missing opened tab query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restart-missing-opened-tab"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opened-tab"}}
Domain trace: dh-restart-missing-opened-tab-query
Action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opened-tab"}}
Trace:
domain trace dh-restart-missing-opened-tab-query: restart missing opened tab query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"restart-missing-opened-tab"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opened-tab"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T20:18:06.821Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-session-reordered-both-current","runs":138,"completedCorpus":true,"failures":25,"duplicateFailures":24,"newFindings":1} -->

### RT-088 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-missing-background-opened-tab-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-background-opened-tab"}} -->

- First seen: 2026-05-23T20:21:41.488Z
- Trace id: `dh-restart-missing-background-opened-tab-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-missing-background-opened-tab-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-missing-background-opened-tab-query: restart missing background opened tab query
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"restart-missing-background-opened-tab"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-background-opened-tab"}}
Domain trace: dh-restart-missing-background-opened-tab-query
Action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-background-opened-tab"}}
Trace:
domain trace dh-restart-missing-background-opened-tab-query: restart missing background opened tab query
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"restart-missing-background-opened-tab"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-background-opened-tab"}}
```

### RT-089 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-missing-active-opened-tab-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-active-opened-tab"}} -->

- First seen: 2026-05-23T20:21:42.609Z
- Trace id: `dh-restart-missing-active-opened-tab-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-missing-active-opened-tab-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-missing-active-opened-tab-query: restart missing active opened tab query
action 1: {"type":"openTab","window":{"windowId":10},"active":true,"captureTab":"restart-missing-active-opened-tab"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-active-opened-tab"}}
Domain trace: dh-restart-missing-active-opened-tab-query
Action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-active-opened-tab"}}
Trace:
domain trace dh-restart-missing-active-opened-tab-query: restart missing active opened tab query
action 1: {"type":"openTab","window":{"windowId":10},"active":true,"captureTab":"restart-missing-active-opened-tab"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-active-opened-tab"}}
```

### RT-090 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: dh-restart-missing-opener-child-query
action: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opener-child"}} -->

- First seen: 2026-05-23T20:21:43.683Z
- Trace id: `dh-restart-missing-opener-child-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-restart-missing-opener-child-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in reconciliation architecture stress tightening pass.

```text
domain trace dh-restart-missing-opener-child-query: restart missing opener child query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"restart-missing-opener-child"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opener-child"}}
Domain trace: dh-restart-missing-opener-child-query
Action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opener-child"}}
Trace:
domain trace dh-restart-missing-opener-child-query: restart missing opener child query
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"restart-missing-opener-child"}
action 2: {"type":"restartBackground"}
action 3: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"restart-missing-opener-child"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T20:21:43.684Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-missing-opener-child-query","runs":141,"completedCorpus":true,"failures":28,"duplicateFailures":25,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T20:25:11.222Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-window-focus-reordered-current","runs":144,"completedCorpus":true,"failures":28,"duplicateFailures":28,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T20:28:27.539Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-native-nonlast-session-refresh","runs":147,"completedCorpus":true,"failures":28,"duplicateFailures":28,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T20:31:56.645Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"dh-restart-opener-updated-reordered","runs":149,"completedCorpus":true,"failures":28,"duplicateFailures":28,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T20:35:18.943Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","relocation","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restore-redo-missing-source-session","runs":106,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T21:01:28.189Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restart-missing-opener-child-query","runs":134,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T21:14:27.000Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restart-missing-opener-child-query","runs":134,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-091 expected closed node tab:2 is live
<!-- signature: expected closed node tab:<id> is live
domain trace: bh-restore-create-reject-tab
action: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:<id>"}} -->

- First seen: 2026-05-23T21:24:51.934Z
- Trace id: `bh-restore-create-reject-tab`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=bh-restore-create-reject-tab pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in restore create side-effect recovery pass.

```text
domain trace bh-restore-create-reject-tab: restore create reject tab
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
Domain trace: bh-restore-create-reject-tab
Action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
Trace:
domain trace bh-restore-create-reject-tab: restore create reject tab
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T21:25:01.148Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"bh-restart-runtime-id-gap","runs":145,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-092 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: bh-restore-create-reject-window
action: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-23T21:31:45.805Z
- Trace id: `bh-restore-create-reject-window`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=bh-restore-create-reject-window pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in restore create side-effect recovery pass.

```text
domain trace bh-restore-create-reject-window: restore create reject window
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
Domain trace: bh-restore-create-reject-window
Action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
Trace:
domain trace bh-restore-create-reject-window: restore create reject window
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
```

### RT-093 expected closed node tab:2 is live
<!-- signature: expected closed node tab:<id> is live
domain trace: bh-restart-restore-create-reject-tab
action: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:<id>"}} -->

- First seen: 2026-05-23T21:31:46.867Z
- Trace id: `bh-restart-restore-create-reject-tab`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=bh-restart-restore-create-reject-tab pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in restore create side-effect recovery pass.

```text
domain trace bh-restart-restore-create-reject-tab: restart restore create reject tab
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"restartBackground"}
action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
Domain trace: bh-restart-restore-create-reject-tab
Action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
Trace:
domain trace bh-restart-restore-create-reject-tab: restart restore create reject tab
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"restartBackground"}
action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
```

### RT-094 expected closed node tab:2 is live
<!-- signature: expected closed node tab:<id> is live
domain trace: bh-restore-create-reject-tab-after-redo
action: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:<id>"}} -->

- First seen: 2026-05-23T21:31:47.901Z
- Trace id: `bh-restore-create-reject-tab-after-redo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=bh-restore-create-reject-tab-after-redo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in restore create side-effect recovery pass.

```text
domain trace bh-restore-create-reject-tab-after-redo: restore create reject tab after redo
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
Domain trace: bh-restore-create-reject-tab-after-redo
Action 4: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
Trace:
domain trace bh-restore-create-reject-tab-after-redo: restore create reject tab after redo
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"outlinerRedo"}
action 4: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
```

### RT-095 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: bh-restart-restore-create-reject-window
action: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-23T21:31:48.943Z
- Trace id: `bh-restart-restore-create-reject-window`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=bh-restart-restore-create-reject-window pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in restore create side-effect recovery pass.

```text
domain trace bh-restart-restore-create-reject-window: restart restore create reject window
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"restartBackground"}
action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
Domain trace: bh-restart-restore-create-reject-window
Action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
Trace:
domain trace bh-restart-restore-create-reject-window: restart restore create reject window
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"restartBackground"}
action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-23T21:31:53.248Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"bh-restart-query-skew-id-gap-focus","runs":153,"completedCorpus":true,"failures":5,"duplicateFailures":1,"newFindings":4} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T21:38:26.165Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"bh-relocation-reject-then-focus-reject","runs":160,"completedCorpus":true,"failures":5,"duplicateFailures":5,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T21:44:33.960Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"bh-restart-after-partial-query-no-command","runs":166,"completedCorpus":true,"failures":5,"duplicateFailures":5,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T21:49:48.511Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"bh-relocation-reject-source-window-only-restart","runs":172,"completedCorpus":true,"failures":5,"duplicateFailures":5,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-23T21:52:59.827Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"dh-restart-missing-opener-child-query","runs":134,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T07:49:27.269Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"bh-restart-restore-create-reject-window","runs":139,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T08:01:50.433Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"bh-restart-restore-create-reject-window","runs":139,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-096 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: ph-close-reject-tab-session-refresh
action: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}} -->

- First seen: 2026-05-24T08:11:28.504Z
- Trace id: `ph-close-reject-tab-session-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-close-reject-tab-session-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in closeNode side-effect recovery and promoted to regression coverage.

```text
domain trace ph-close-reject-tab-session-refresh: close reject tab session refresh
action 1: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}}
Domain trace: ph-close-reject-tab-session-refresh
Action 1: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}}
Trace:
domain trace ph-close-reject-tab-session-refresh: close reject tab session refresh
action 1: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}}
```

### RT-097 Missing runtime window 21
<!-- signature: Missing runtime window <id>
domain trace: ph-opener-grandchild-redo-missing-destination
action: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"lastOpenedWindow"}} -->

- First seen: 2026-05-24T08:11:37.482Z
- Trace id: `ph-opener-grandchild-redo-missing-destination`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-opener-grandchild-redo-missing-destination pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: triaged as harness artifact; trace now uses current moved-tab evidence instead of stale `lastOpenedWindow`.

```text
domain trace ph-opener-grandchild-redo-missing-destination: opener grandchild redo missing destination
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"ph-opener-redo-child"}
action 2: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"capture":"ph-opener-redo-child"},"captureTab":"ph-opener-redo-grandchild"}
action 3: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"ph-opener-redo-grandchild"},"captureStaleTabs":"ph-opener-redo-old"}
action 4: {"type":"outlinerUndo"}
action 5: {"type":"outlinerRedo"}
action 6: {"type":"manualRefreshWithMissingWindowQuery","window":{"role":"lastOpenedWindow"}}
```

### RT-098 expected closed node tab:100 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: ph-focus-after-close-reject-session
action: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"capture":"ph-focus-close-reject-tab"}}} -->

- First seen: 2026-05-24T08:11:44.024Z
- Trace id: `ph-focus-after-close-reject-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-focus-after-close-reject-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in closeNode side-effect recovery and promoted to regression coverage.

```text
domain trace ph-focus-after-close-reject-session: focus after close reject session
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"ph-focus-close-reject-tab"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"capture":"ph-focus-close-reject-tab"}}}
Domain trace: ph-focus-after-close-reject-session
Action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"capture":"ph-focus-close-reject-tab"}}}
Trace:
domain trace ph-focus-after-close-reject-session: focus after close reject session
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"ph-focus-close-reject-tab"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"capture":"ph-focus-close-reject-tab"}}}
```

### RT-099 expected closed node window:21 is live
<!-- signature: expected closed node window:<id> is live
domain trace: ph-restart-close-reject-stale-old
action: {"type":"outlinerCloseNodeRejectingClose","node":{"window":{"windowId":10}}} -->

- First seen: 2026-05-24T08:11:46.193Z
- Trace id: `ph-restart-close-reject-stale-old`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-restart-close-reject-stale-old pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: triaged as harness artifact; outliner closing a live source window intentionally preserves/promotes foreign live windows.

```text
domain trace ph-restart-close-reject-stale-old: restart close reject stale old
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"ph-restart-close-reject-old"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"window":{"windowId":10}}}
Domain trace: ph-restart-close-reject-stale-old
Action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"window":{"windowId":10}}}
Trace:
domain trace ph-restart-close-reject-stale-old: restart close reject stale old
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"ph-restart-close-reject-old"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"window":{"windowId":10}}}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T08:11:47.271Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-restart-restore-native-id-gap","runs":185,"completedCorpus":true,"failures":4,"duplicateFailures":0,"newFindings":4} -->

### RT-100 Missing runtime tab 2
<!-- signature: Missing runtime tab <id>
domain trace: ph-restore-tab-native-source-missing
action: {"type":"nativeCloseTab","tab":{"tabId":2},"order":"tabRemovedOnly"} -->

- First seen: 2026-05-24T08:17:40.508Z
- Trace id: `ph-restore-tab-native-source-missing`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-restore-tab-native-source-missing pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: triaged as harness artifact; trace now uses the current restored runtime tab instead of the old closed tab id.

```text
domain trace ph-restore-tab-native-source-missing: restore tab native source missing
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"}}
action 3: {"type":"nativeCloseTab","tab":{"tabId":2},"order":"tabRemovedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T08:17:45.840Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-focus-close-reject-window-restart-session","runs":191,"completedCorpus":true,"failures":5,"duplicateFailures":4,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T08:23:02.067Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-restore-window-native-restart-partial","runs":197,"completedCorpus":true,"failures":5,"duplicateFailures":5,"newFindings":0} -->

### RT-101 Missing focused runtime window
<!-- signature: Missing focused runtime window
domain trace: ph-opener-source-delete-redo-reordered
action: {"type":"manualRefreshWithReorderedQuery","window":{"role":"focusedWindow"},"order":"rotateLeft"} -->

- First seen: 2026-05-24T08:27:48.467Z
- Trace id: `ph-opener-source-delete-redo-reordered`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-opener-source-delete-redo-reordered pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: triaged as harness artifact; trace now uses `firstRuntimeWindow` because a focused runtime window is not guaranteed after source delete/history replay.

```text
domain trace ph-opener-source-delete-redo-reordered: opener source delete redo reordered
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"ph-opener-delete-child"}
action 2: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"capture":"ph-opener-delete-child"},"captureTab":"ph-opener-delete-grandchild"}
action 3: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"ph-opener-delete-grandchild"},"captureStaleTabs":"ph-opener-delete-old"}
action 4: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 5: {"type":"outlinerUndo"}
action 6: {"type":"outlinerRedo"}
action 7: {"type":"manualRefreshWithReorderedQuery","window":{"role":"focusedWindow"},"order":"rotateLeft"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T08:27:52.163Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-focus-reject-after-native-window-only","runs":203,"completedCorpus":true,"failures":6,"duplicateFailures":5,"newFindings":1} -->

### RT-102 domain restore tab create rejected after completion
<!-- signature: domain restore tab create rejected after completion
domain trace: ph-restore-delete-redo-first-query
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T08:32:55.645Z
- Trace id: `ph-restore-delete-redo-first-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-restore-delete-redo-first-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: triaged as harness artifact; rejecting restore-create mocks are now scoped to the selected node kind so unused tab mocks cannot poison later undo.

```text
domain trace ph-restore-delete-redo-first-query: restore delete redo first query
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"}}
action 3: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"role":"firstRuntimeWindow"}}}
action 4: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T08:33:00.373Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-query-created-focus-session-first","runs":209,"completedCorpus":true,"failures":7,"duplicateFailures":6,"newFindings":1} -->

### RT-103 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: ph-close-reject-tab-undo-redo
action: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}} -->

- First seen: 2026-05-24T08:37:58.333Z
- Trace id: `ph-close-reject-tab-undo-redo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ph-close-reject-tab-undo-redo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in closeNode side-effect recovery and promoted to regression coverage.

```text
domain trace ph-close-reject-tab-undo-redo: close reject tab undo redo
action 1: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}}
Domain trace: ph-close-reject-tab-undo-redo
Action 1: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}}
Trace:
domain trace ph-close-reject-tab-undo-redo: close reject tab undo redo
action 1: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"tabId":2}}}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T08:37:58.334Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-close-reject-tab-undo-redo","runs":213,"completedCorpus":true,"failures":8,"duplicateFailures":7,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T08:43:48.328Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-restore-native-window-only-after-recovery","runs":172,"completedCorpus":false,"failures":1,"duplicateFailures":1,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T08:49:34.537Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-native-tabs-only-refresh-restart","runs":216,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T08:54:14.687Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-relocation-fresh-restart-missing-tab","runs":218,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T08:59:03.794Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ph-relocation-session-source-destination-skew","runs":220,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T09:02:27.985Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"bh-restart-restore-create-reject-window","runs":139,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T09:31:49.323Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"ph-close-reject-tab-undo-redo","runs":142,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T09:59:57.009Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"ph-close-reject-tab-undo-redo","runs":142,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T10:10:37.279Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"lh-id-gap-history-replay","runs":237,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-104 expected closed node tab:1 is live
<!-- signature: expected closed node tab:<id> is live
domain trace: lh-relocated-tab-close-reject-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T10:17:25.882Z
- Trace id: `lh-relocated-tab-close-reject-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=lh-relocated-tab-close-reject-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history replay closed-lifecycle guard and promoted to regression coverage.

```text
domain trace lh-relocated-tab-close-reject-history: relocated tab close reject history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"lh-relocated-close-history-old"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"role":"lastMovedTab"}}}
action 3: {"type":"outlinerUndo"}
Domain trace: lh-relocated-tab-close-reject-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace lh-relocated-tab-close-reject-history: relocated tab close reject history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"lh-relocated-close-history-old"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"tab":{"role":"lastMovedTab"}}}
action 3: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T10:17:29.274Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"lh-close-reject-focus-reject-restart-current","runs":247,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-105 expected closed node tab:1 is live
<!-- signature: expected closed node tab:<id> is live
domain trace: lh-relocated-window-close-reject-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T10:23:46.052Z
- Trace id: `lh-relocated-window-close-reject-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=lh-relocated-window-close-reject-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history replay closed-lifecycle guard and promoted to regression coverage.

```text
domain trace lh-relocated-window-close-reject-history: relocated window close reject history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"lh-relocated-window-history-old"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"window":{"role":"lastOpenedWindow"}}}
action 3: {"type":"outlinerUndo"}
Domain trace: lh-relocated-window-close-reject-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace lh-relocated-window-close-reject-history: relocated window close reject history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"lh-relocated-window-history-old"}
action 2: {"type":"outlinerCloseNodeRejectingClose","node":{"window":{"role":"lastOpenedWindow"}}}
action 3: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T10:23:52.327Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"lh-close-reject-multitab-window-undo-query","runs":253,"completedCorpus":true,"failures":2,"duplicateFailures":1,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T10:30:03.927Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"lh-browser-created-close-reject-partial","runs":258,"completedCorpus":true,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T10:36:04.610Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"lh-focus-reject-two-window-reorder","runs":262,"completedCorpus":true,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T10:42:03.431Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"lh-relocation-fresh-current-native-source-close","runs":265,"completedCorpus":true,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T10:45:00.523Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"ph-close-reject-tab-undo-redo","runs":142,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T11:23:35.735Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"lh-relocated-window-close-reject-history","runs":144,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T11:36:03.859Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"lh-relocated-window-close-reject-history","runs":144,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-106 native-deleted node tab:1 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-native-close-after-relocation-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:44:45.034Z
- Trace id: `hh-native-close-after-relocation-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-close-after-relocation-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-close-after-relocation-history: native close after relocation history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-close-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-native-close-after-relocation-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-close-after-relocation-history: native close after relocation history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-close-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"outlinerUndo"}
```

### RT-107 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-delete-source-window-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:45:01.551Z
- Trace id: `hh-delete-source-window-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-window-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-window-history: delete source window history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-window-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-window-history: delete source window history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T11:45:02.716Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-restore-window-history-restart","runs":281,"completedCorpus":true,"failures":2,"duplicateFailures":0,"newFindings":2} -->

### RT-108 native-deleted node tab:1 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-native-close-group-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:53:10.053Z
- Trace id: `hh-native-close-group-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-close-group-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-close-group-history: native close group history
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"hh-native-group-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-native-close-group-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-close-group-history: native close group history
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"hh-native-group-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"outlinerUndo"}
```

### RT-109 native-deleted node tab:100 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-native-close-opener-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:53:11.188Z
- Trace id: `hh-native-close-opener-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-close-opener-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-close-opener-history: native close opener history
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"hh-native-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"hh-native-opener-child"},"captureStaleTabs":"hh-native-opener-old"}
action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-native-close-opener-history
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-close-opener-history: native close opener history
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"hh-native-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"hh-native-opener-child"},"captureStaleTabs":"hh-native-opener-old"}
action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 4: {"type":"outlinerUndo"}
```

### RT-110 native-deleted node tab:1 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-native-close-restart-before-undo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:53:12.411Z
- Trace id: `hh-native-close-restart-before-undo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-close-restart-before-undo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-close-restart-before-undo: native close restart before undo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-restart-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-native-close-restart-before-undo
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-close-restart-before-undo: native close restart before undo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-restart-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
```

### RT-111 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: hh-delete-source-group-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:53:14.718Z
- Trace id: `hh-delete-source-group-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-group-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-group-history: delete source group history
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-group-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-group-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-group-history: delete source group history
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-group-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
```

### RT-112 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-delete-source-focus-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:53:16.953Z
- Trace id: `hh-delete-source-focus-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-focus-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-focus-history: delete source focus history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-focus-old"}
action 2: {"type":"outlinerFocusTab","tab":{"tabId":3}}
action 3: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-focus-history
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-focus-history: delete source focus history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-focus-old"}
action 2: {"type":"outlinerFocusTab","tab":{"tabId":3}}
action 3: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 4: {"type":"outlinerUndo"}
```

### RT-113 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-delete-source-reordered-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T11:53:18.101Z
- Trace id: `hh-delete-source-reordered-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-reordered-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-reordered-history: delete source reordered history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-reordered-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-reordered-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-reordered-history: delete source reordered history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-reordered-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T11:53:18.102Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-delete-source-reordered-history","runs":289,"completedCorpus":true,"failures":8,"duplicateFailures":2,"newFindings":6} -->

### RT-114 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: hh-native-source-window-tabs-then-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:01:24.186Z
- Trace id: `hh-native-source-window-tabs-then-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-source-window-tabs-then-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-source-window-tabs-then-history: native source window tabs then history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-tabs-then-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-native-source-window-tabs-then-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-source-window-tabs-then-history: native source window tabs then history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-tabs-then-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerUndo"}
```

### RT-115 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: hh-native-source-window-restart-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:01:25.444Z
- Trace id: `hh-native-source-window-restart-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-source-window-restart-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-source-window-restart-history: native source window restart history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-restart-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"windowRemovedThenTabsRemoved"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-native-source-window-restart-history
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-source-window-restart-history: native source window restart history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-restart-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"windowRemovedThenTabsRemoved"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
```

### RT-116 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-delete-source-window-redo-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:01:26.674Z
- Trace id: `hh-delete-source-window-redo-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-window-redo-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-window-redo-history: delete source window redo history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-redo-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-window-redo-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-window-redo-history: delete source window redo history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-redo-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
```

### RT-117 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-delete-source-restart-before-undo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:01:27.905Z
- Trace id: `hh-delete-source-restart-before-undo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-restart-before-undo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-restart-before-undo: delete source restart before undo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-restart-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-restart-before-undo
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-restart-before-undo: delete source restart before undo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-restart-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
```

### RT-118 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-delete-source-stale-after-redo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:01:29.152Z
- Trace id: `hh-delete-source-stale-after-redo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-delete-source-stale-after-redo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-delete-source-stale-after-redo: delete source stale after redo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-stale-redo-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-delete-source-stale-after-redo
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-delete-source-stale-after-redo: delete source stale after redo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-delete-source-stale-redo-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
```

### RT-119 tab 4 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: hh-top-level-delete-source-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:01:32.944Z
- Trace id: `hh-top-level-delete-source-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-top-level-delete-source-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-top-level-delete-source-history: top level delete source history
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"hh-top-level-delete-source-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-top-level-delete-source-history
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-top-level-delete-source-history: top level delete source history
action 1: {"type":"outlinerMoveSubtreeToTopLevel","tab":{"tabId":1},"captureStaleTabs":"hh-top-level-delete-source-old"}
action 2: {"type":"outlinerDeleteNodeRejectingClose","node":{"window":{"windowId":10}}}
action 3: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T12:01:32.945Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-top-level-delete-source-history","runs":299,"completedCorpus":true,"failures":14,"duplicateFailures":8,"newFindings":6} -->

### RT-120 native-deleted node tab:2 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-restored-tab-native-close-history
action: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-tab"},"order":"tabRemovedThenSessionChanged"} -->

- First seen: 2026-05-24T12:09:38.167Z
- Trace id: `hh-restored-tab-native-close-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-restored-tab-native-close-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-restored-tab-native-close-history: restored tab native close history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-tab"},"order":"tabRemovedThenSessionChanged"}
Domain trace: hh-restored-tab-native-close-history
Action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-tab"},"order":"tabRemovedThenSessionChanged"}
Trace:
domain trace hh-restored-tab-native-close-history: restored tab native close history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-tab"},"order":"tabRemovedThenSessionChanged"}
```

### RT-121 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: hh-native-source-window-only-redo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:09:42.955Z
- Trace id: `hh-native-source-window-only-redo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-source-window-only-redo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-source-window-only-redo: native source window only redo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-window-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-native-source-window-only-redo
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-source-window-only-redo: native source window only redo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-window-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerUndo"}
```

### RT-122 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: hh-native-source-tabs-only-redo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:09:44.171Z
- Trace id: `hh-native-source-tabs-only-redo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-source-tabs-only-redo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-source-tabs-only-redo: native source tabs only redo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
action 3: {"type":"outlinerUndo"}
Domain trace: hh-native-source-tabs-only-redo
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-source-tabs-only-redo: native source tabs only redo
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-tabs-only-old"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedOnly"}
action 3: {"type":"outlinerUndo"}
```

### RT-123 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: hh-native-source-focus-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:09:45.353Z
- Trace id: `hh-native-source-focus-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-source-focus-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-source-focus-history: native source focus history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-focus-old"}
action 2: {"type":"outlinerFocusTab","tab":{"role":"lastMovedTab"}}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedThenWindowRemoved"}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-native-source-focus-history
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-source-focus-history: native source focus history
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"hh-native-source-focus-old"}
action 2: {"type":"outlinerFocusTab","tab":{"role":"lastMovedTab"}}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedThenWindowRemoved"}
action 4: {"type":"outlinerUndo"}
```

### RT-124 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
domain trace: hh-native-source-opener-history
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T12:09:46.570Z
- Trace id: `hh-native-source-opener-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-native-source-opener-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-native-source-opener-history: native source opener history
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"hh-native-source-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"hh-native-source-opener-child"},"captureStaleTabs":"hh-native-source-opener-old"}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedThenWindowRemoved"}
action 4: {"type":"outlinerUndo"}
Domain trace: hh-native-source-opener-history
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace hh-native-source-opener-history: native source opener history
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"hh-native-source-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"hh-native-source-opener-child"},"captureStaleTabs":"hh-native-source-opener-old"}
action 3: {"type":"nativeCloseWindow","window":{"windowId":10},"order":"tabsRemovedThenWindowRemoved"}
action 4: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T12:09:46.571Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-native-source-opener-history","runs":307,"completedCorpus":true,"failures":19,"duplicateFailures":14,"newFindings":5} -->

### RT-125 native-deleted node tab:2 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-restored-tab-native-session-history
action: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-session-tab"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-24T12:17:43.988Z
- Trace id: `hh-restored-tab-native-session-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-restored-tab-native-session-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-restored-tab-native-session-history: restored tab native session history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-session-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-session-tab"},"order":"sessionChangedOnly"}
Domain trace: hh-restored-tab-native-session-history
Action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-session-tab"},"order":"sessionChangedOnly"}
Trace:
domain trace hh-restored-tab-native-session-history: restored tab native session history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-session-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-session-tab"},"order":"sessionChangedOnly"}
```

### RT-126 native-deleted node tab:2 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-restored-tab-native-restart-history
action: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-restart-tab"},"order":"tabRemovedOnly"} -->

- First seen: 2026-05-24T12:17:45.137Z
- Trace id: `hh-restored-tab-native-restart-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-restored-tab-native-restart-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-restored-tab-native-restart-history: restored tab native restart history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-restart-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-restart-tab"},"order":"tabRemovedOnly"}
Domain trace: hh-restored-tab-native-restart-history
Action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-restart-tab"},"order":"tabRemovedOnly"}
Trace:
domain trace hh-restored-tab-native-restart-history: restored tab native restart history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-restart-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-restart-tab"},"order":"tabRemovedOnly"}
```

### RT-127 native-deleted node tab:2 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: hh-restored-tab-native-stale-history
action: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-stale-tab"},"order":"tabRemovedThenSessionChanged"} -->

- First seen: 2026-05-24T12:17:46.254Z
- Trace id: `hh-restored-tab-native-stale-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=hh-restored-tab-native-stale-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in history-boundary lifecycle guard pass and promoted to regression coverage.

```text
domain trace hh-restored-tab-native-stale-history: restored tab native stale history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-stale-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-stale-tab"},"order":"tabRemovedThenSessionChanged"}
Domain trace: hh-restored-tab-native-stale-history
Action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-stale-tab"},"order":"tabRemovedThenSessionChanged"}
Trace:
domain trace hh-restored-tab-native-stale-history: restored tab native stale history
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"hh-restored-native-stale-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"hh-restored-native-stale-tab"},"order":"tabRemovedThenSessionChanged"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T12:17:51.847Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-restored-window-native-missing-history","runs":315,"completedCorpus":true,"failures":22,"duplicateFailures":19,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T12:26:01.991Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-control-restore-window-redo-history","runs":319,"completedCorpus":true,"failures":22,"duplicateFailures":22,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T12:33:37.771Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-control-delete-created-restart-history","runs":322,"completedCorpus":true,"failures":22,"duplicateFailures":22,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T12:41:07.045Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","manual-refresh","metadata","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"hh-control-created-window-delete-history","runs":325,"completedCorpus":true,"failures":22,"duplicateFailures":22,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T12:44:19.576Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"lh-relocated-window-close-reject-history","runs":144,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T13:13:16.901Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"hh-restored-tab-native-stale-history","runs":166,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T14:07:05.855Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"hh-restored-tab-native-stale-history","runs":166,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-128 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: jh-close-tab-abrupt-stale-update
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-close-tab-stale"} -->

- First seen: 2026-05-24T14:49:01.774Z
- Trace id: `jh-close-tab-abrupt-stale-update`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-tab-abrupt-stale-update pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-tab-abrupt-stale-update: journal close tab abrupt stale update
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-close-tab-stale"}
Domain trace: jh-close-tab-abrupt-stale-update
Action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-close-tab-stale"}
Trace:
domain trace jh-close-tab-abrupt-stale-update: journal close tab abrupt stale update
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-close-tab-stale"}
```

### RT-129 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-close-single-window-abrupt-session
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-single-window-stale"} -->

- First seen: 2026-05-24T14:49:02.972Z
- Trace id: `jh-close-single-window-abrupt-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-single-window-abrupt-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-single-window-abrupt-session: journal close single window abrupt session
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-single-window-stale"}
Domain trace: jh-close-single-window-abrupt-session
Action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-single-window-stale"}
Trace:
domain trace jh-close-single-window-abrupt-session: journal close single window abrupt session
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-single-window-stale"}
```

### RT-130 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-close-multi-window-abrupt-refresh
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-multi-stale"} -->

- First seen: 2026-05-24T14:49:04.184Z
- Trace id: `jh-close-multi-window-abrupt-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-multi-window-abrupt-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-multi-window-abrupt-refresh: journal close multi window abrupt refresh
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"jh-close-multi-extra"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-multi-stale"}
Domain trace: jh-close-multi-window-abrupt-refresh
Action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-multi-stale"}
Trace:
domain trace jh-close-multi-window-abrupt-refresh: journal close multi window abrupt refresh
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"jh-close-multi-extra"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":20}},"captureStaleTabs":"jh-close-multi-stale"}
```

### RT-131 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-close-grouped-window-abrupt-reordered
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-group-stale"} -->

- First seen: 2026-05-24T14:49:05.391Z
- Trace id: `jh-close-grouped-window-abrupt-reordered`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-grouped-window-abrupt-reordered pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-grouped-window-abrupt-reordered: journal close grouped window abrupt reordered
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"jh-close-group-old"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-group-stale"}
Domain trace: jh-close-grouped-window-abrupt-reordered
Action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-group-stale"}
Trace:
domain trace jh-close-grouped-window-abrupt-reordered: journal close grouped window abrupt reordered
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"jh-close-group-old"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-group-stale"}
```

### RT-132 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: jh-undo-close-abrupt-missing
action: {"type":"outlinerUndoThenAbruptRestart"} -->

- First seen: 2026-05-24T14:49:20.892Z
- Trace id: `jh-undo-close-abrupt-missing`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-undo-close-abrupt-missing pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-undo-close-abrupt-missing: journal undo close abrupt missing
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerUndoThenAbruptRestart"}
Domain trace: jh-undo-close-abrupt-missing
Action 2: {"type":"outlinerUndoThenAbruptRestart"}
Trace:
domain trace jh-undo-close-abrupt-missing: journal undo close abrupt missing
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerUndoThenAbruptRestart"}
```

### RT-133 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: jh-journal-recovered-stale-contradiction
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-stale-tab"} -->

- First seen: 2026-05-24T14:49:29.338Z
- Trace id: `jh-journal-recovered-stale-contradiction`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-journal-recovered-stale-contradiction pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-journal-recovered-stale-contradiction: journal recovered stale contradiction
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-stale-tab"}
Domain trace: jh-journal-recovered-stale-contradiction
Action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-stale-tab"}
Trace:
domain trace jh-journal-recovered-stale-contradiction: journal recovered stale contradiction
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-stale-tab"}
```

### RT-134 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: jh-journal-recovered-native-contradiction
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-native-stale"} -->

- First seen: 2026-05-24T14:49:30.563Z
- Trace id: `jh-journal-recovered-native-contradiction`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-journal-recovered-native-contradiction pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-journal-recovered-native-contradiction: journal recovered native contradiction
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-native-stale"}
Domain trace: jh-journal-recovered-native-contradiction
Action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-native-stale"}
Trace:
domain trace jh-journal-recovered-native-contradiction: journal recovered native contradiction
action 1: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"tabId":2}},"captureStaleTabs":"jh-recovered-native-stale"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T14:49:30.565Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-journal-recovered-native-contradiction","runs":327,"processRuns":44,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":7,"duplicateFailures":0,"newFindings":7} -->

### RT-135 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-close-relocated-destination-abrupt-old-event
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-relocated-destination"} -->

- First seen: 2026-05-24T14:52:35.241Z
- Trace id: `jh-close-relocated-destination-abrupt-old-event`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-relocated-destination-abrupt-old-event pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-relocated-destination-abrupt-old-event: journal close relocated destination abrupt old event
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"jh-close-relocated-old"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-relocated-destination"}
Domain trace: jh-close-relocated-destination-abrupt-old-event
Action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-relocated-destination"}
Trace:
domain trace jh-close-relocated-destination-abrupt-old-event: journal close relocated destination abrupt old event
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"jh-close-relocated-old"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"role":"lastOpenedWindow"}},"captureStaleTabs":"jh-close-relocated-destination"}
```

### RT-136 expected closed node window:10 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-close-relocated-source-abrupt-session
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":10}},"captureStaleTabs":"jh-close-source-stale"} -->

- First seen: 2026-05-24T14:52:36.382Z
- Trace id: `jh-close-relocated-source-abrupt-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-relocated-source-abrupt-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-relocated-source-abrupt-session: journal close relocated source abrupt session
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"jh-close-source-old"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":10}},"captureStaleTabs":"jh-close-source-stale"}
Domain trace: jh-close-relocated-source-abrupt-session
Action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":10}},"captureStaleTabs":"jh-close-source-stale"}
Trace:
domain trace jh-close-relocated-source-abrupt-session: journal close relocated source abrupt session
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"jh-close-source-old"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"windowId":10}},"captureStaleTabs":"jh-close-source-stale"}
```

### RT-137 expected closed node tab:2 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: jh-close-restored-tab-abrupt-session
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-restored-tab"}},"captureStaleTabs":"jh-close-restored-tab-stale"} -->

- First seen: 2026-05-24T14:52:37.532Z
- Trace id: `jh-close-restored-tab-abrupt-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-restored-tab-abrupt-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-restored-tab-abrupt-session: journal close restored tab abrupt session
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"jh-close-restored-tab"}
action 3: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-restored-tab"}},"captureStaleTabs":"jh-close-restored-tab-stale"}
Domain trace: jh-close-restored-tab-abrupt-session
Action 3: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-restored-tab"}},"captureStaleTabs":"jh-close-restored-tab-stale"}
Trace:
domain trace jh-close-restored-tab-abrupt-session: journal close restored tab abrupt session
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"jh-close-restored-tab"}
action 3: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-restored-tab"}},"captureStaleTabs":"jh-close-restored-tab-stale"}
```

### RT-138 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-close-restored-window-abrupt-missing
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"capture":"jh-close-restored-window"}},"captureStaleTabs":"jh-close-restored-window-stale"} -->

- First seen: 2026-05-24T14:52:38.702Z
- Trace id: `jh-close-restored-window-abrupt-missing`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-restored-window-abrupt-missing pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-restored-window-abrupt-missing: journal close restored window abrupt missing
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-close-restored-window"}
action 3: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"capture":"jh-close-restored-window"}},"captureStaleTabs":"jh-close-restored-window-stale"}
Domain trace: jh-close-restored-window-abrupt-missing
Action 3: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"capture":"jh-close-restored-window"}},"captureStaleTabs":"jh-close-restored-window-stale"}
Trace:
domain trace jh-close-restored-window-abrupt-missing: journal close restored window abrupt missing
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-close-restored-window"}
action 3: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"window":{"capture":"jh-close-restored-window"}},"captureStaleTabs":"jh-close-restored-window-stale"}
```

### RT-139 expected closed node tab:100 is missing
<!-- signature: expected closed node tab:<id> is missing
domain trace: jh-close-opener-child-abrupt-query
action: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-opener-child"}},"captureStaleTabs":"jh-close-opener-stale"} -->

- First seen: 2026-05-24T14:52:39.873Z
- Trace id: `jh-close-opener-child-abrupt-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-close-opener-child-abrupt-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-close-opener-child-abrupt-query: journal close opener child abrupt query
action 1: {"type":"openTab","window":{"windowId":10},"openerTab":{"tabId":1},"active":false,"captureTab":"jh-close-opener-child"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-opener-child"}},"captureStaleTabs":"jh-close-opener-stale"}
Domain trace: jh-close-opener-child-abrupt-query
Action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-opener-child"}},"captureStaleTabs":"jh-close-opener-stale"}
Trace:
domain trace jh-close-opener-child-abrupt-query: journal close opener child abrupt query
action 1: {"type":"openTab","window":{"windowId":10},"openerTab":{"tabId":1},"active":false,"captureTab":"jh-close-opener-child"}
action 2: {"type":"outlinerCloseNodeThenAbruptRestart","node":{"tab":{"capture":"jh-close-opener-child"}},"captureStaleTabs":"jh-close-opener-stale"}
```

### RT-140 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-window-close-undo-abrupt-refresh
action: {"type":"outlinerUndoThenAbruptRestart"} -->

- First seen: 2026-05-24T14:52:41.027Z
- Trace id: `jh-window-close-undo-abrupt-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-window-close-undo-abrupt-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-window-close-undo-abrupt-refresh: journal window close undo abrupt refresh
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerUndoThenAbruptRestart"}
Domain trace: jh-window-close-undo-abrupt-refresh
Action 2: {"type":"outlinerUndoThenAbruptRestart"}
Trace:
domain trace jh-window-close-undo-abrupt-refresh: journal window close undo abrupt refresh
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerUndoThenAbruptRestart"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T14:52:41.028Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-window-close-undo-abrupt-refresh","runs":333,"processRuns":50,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":13,"duplicateFailures":7,"newFindings":6} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T14:56:24.056Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-relocate-opener-child-abrupt-session","runs":338,"processRuns":55,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":13,"duplicateFailures":13,"newFindings":0} -->

### RT-141 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: jh-delete-opener-child-abrupt-stale
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opener-stale"},"withStaleQuery":true} -->

- First seen: 2026-05-24T14:59:07.559Z
- Trace id: `jh-delete-opener-child-abrupt-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-delete-opener-child-abrupt-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-delete-opener-child-abrupt-stale: journal delete opener child abrupt stale
action 1: {"type":"openTab","window":{"windowId":10},"openerTab":{"tabId":1},"active":false,"captureTab":"jh-delete-opener-child"}
action 2: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"tab":{"capture":"jh-delete-opener-child"}},"captureStaleTabs":"jh-delete-opener-stale"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opener-stale"},"withStaleQuery":true}
Domain trace: jh-delete-opener-child-abrupt-stale
Action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opener-stale"},"withStaleQuery":true}
Trace:
domain trace jh-delete-opener-child-abrupt-stale: journal delete opener child abrupt stale
action 1: {"type":"openTab","window":{"windowId":10},"openerTab":{"tabId":1},"active":false,"captureTab":"jh-delete-opener-child"}
action 2: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"tab":{"capture":"jh-delete-opener-child"}},"captureStaleTabs":"jh-delete-opener-stale"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opener-stale"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T14:59:08.752Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-redo-restore-abrupt-refresh","runs":344,"processRuns":58,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":14,"duplicateFailures":13,"newFindings":1} -->

### RT-142 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: jh-delete-opener-child-abrupt-updated
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"jh-delete-opener-updated-stale"},"withStaleQuery":true} -->

- First seen: 2026-05-24T15:01:24.251Z
- Trace id: `jh-delete-opener-child-abrupt-updated`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-delete-opener-child-abrupt-updated pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-delete-opener-child-abrupt-updated: journal delete opener child abrupt updated
action 1: {"type":"openTab","window":{"windowId":10},"openerTab":{"tabId":1},"active":false,"captureTab":"jh-delete-opener-updated-child"}
action 2: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"tab":{"capture":"jh-delete-opener-updated-child"}},"captureStaleTabs":"jh-delete-opener-updated-stale"}
action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"jh-delete-opener-updated-stale"},"withStaleQuery":true}
Domain trace: jh-delete-opener-child-abrupt-updated
Action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"jh-delete-opener-updated-stale"},"withStaleQuery":true}
Trace:
domain trace jh-delete-opener-child-abrupt-updated: journal delete opener child abrupt updated
action 1: {"type":"openTab","window":{"windowId":10},"openerTab":{"tabId":1},"active":false,"captureTab":"jh-delete-opener-updated-child"}
action 2: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"tab":{"capture":"jh-delete-opener-updated-child"}},"captureStaleTabs":"jh-delete-opener-updated-stale"}
action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"jh-delete-opener-updated-stale"},"withStaleQuery":true}
```

### RT-143 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: jh-delete-opened-child-abrupt-created
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opened-stale"},"withStaleQuery":true} -->

- First seen: 2026-05-24T15:01:25.445Z
- Trace id: `jh-delete-opened-child-abrupt-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-delete-opened-child-abrupt-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-delete-opened-child-abrupt-created: journal delete opened child abrupt created
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"jh-delete-opened-child"}
action 2: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"tab":{"capture":"jh-delete-opened-child"}},"captureStaleTabs":"jh-delete-opened-stale"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opened-stale"},"withStaleQuery":true}
Domain trace: jh-delete-opened-child-abrupt-created
Action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opened-stale"},"withStaleQuery":true}
Trace:
domain trace jh-delete-opened-child-abrupt-created: journal delete opened child abrupt created
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"jh-delete-opened-child"}
action 2: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"tab":{"capture":"jh-delete-opened-child"}},"captureStaleTabs":"jh-delete-opened-stale"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"jh-delete-opened-stale"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T15:01:27.829Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-delete-opener-window-abrupt-created","runs":348,"processRuns":66,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":16,"duplicateFailures":14,"newFindings":2} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:03:37.924Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-delete-relocated-destination-abrupt-created","runs":352,"processRuns":70,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

### RT-144 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-window-no-journal-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:05:57.125Z
- Trace id: `jh-native-window-no-journal-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-window-no-journal-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-window-no-journal-abrupt: native window no journal abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"windowRemovedOnly"}
action 2: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-window-no-journal-abrupt
Action 2: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-window-no-journal-abrupt: native window no journal abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"windowRemovedOnly"}
action 2: {"type":"restartBackgroundAbrupt"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T15:05:57.126Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-native-window-no-journal-abrupt","runs":356,"processRuns":74,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":17,"duplicateFailures":16,"newFindings":1} -->

### RT-145 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-window-tabs-then-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:08:16.835Z
- Trace id: `jh-native-window-tabs-then-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-window-tabs-then-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-window-tabs-then-abrupt: native window tabs then abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"tabsRemovedThenWindowRemoved"}
action 2: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-window-tabs-then-abrupt
Action 2: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-window-tabs-then-abrupt: native window tabs then abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"tabsRemovedThenWindowRemoved"}
action 2: {"type":"restartBackgroundAbrupt"}
```

### RT-146 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-window-window-then-tabs-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:08:17.960Z
- Trace id: `jh-native-window-window-then-tabs-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-window-window-then-tabs-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-window-window-then-tabs-abrupt: native window window then tabs abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"windowRemovedThenTabsRemoved"}
action 2: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-window-window-then-tabs-abrupt
Action 2: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-window-window-then-tabs-abrupt: native window window then tabs abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"windowRemovedThenTabsRemoved"}
action 2: {"type":"restartBackgroundAbrupt"}
```

### RT-147 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-window-tabs-only-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:08:19.094Z
- Trace id: `jh-native-window-tabs-only-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-window-tabs-only-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-window-tabs-only-abrupt: native window tabs only abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"tabsRemovedOnly"}
action 2: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-window-tabs-only-abrupt
Action 2: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-window-tabs-only-abrupt: native window tabs only abrupt
action 1: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"tabsRemovedOnly"}
action 2: {"type":"restartBackgroundAbrupt"}
```

### RT-148 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-multitab-window-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:08:20.235Z
- Trace id: `jh-native-multitab-window-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-multitab-window-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-multitab-window-abrupt: native multitab window abrupt
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"jh-native-multitab-extra"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-multitab-window-abrupt
Action 3: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-multitab-window-abrupt: native multitab window abrupt
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"jh-native-multitab-extra"}
action 2: {"type":"nativeCloseWindow","window":{"windowId":20},"order":"windowRemovedOnly"}
action 3: {"type":"restartBackgroundAbrupt"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T15:08:20.236Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-native-multitab-window-abrupt","runs":360,"processRuns":78,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":21,"duplicateFailures":17,"newFindings":4} -->

### RT-149 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-restored-window-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:10:38.911Z
- Trace id: `jh-native-restored-window-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-restored-window-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-restored-window-abrupt: native restored window abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-window"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-window"},"order":"windowRemovedOnly"}
action 4: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-restored-window-abrupt
Action 4: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-restored-window-abrupt: native restored window abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-window"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-window"},"order":"windowRemovedOnly"}
action 4: {"type":"restartBackgroundAbrupt"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T15:10:38.913Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-native-restored-window-abrupt","runs":363,"processRuns":82,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":22,"duplicateFailures":21,"newFindings":1} -->

### RT-150 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-restored-window-tabs-then-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:13:02.821Z
- Trace id: `jh-native-restored-window-tabs-then-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-restored-window-tabs-then-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-restored-window-tabs-then-abrupt: native restored window tabs then abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-tabs-then-window"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-tabs-then-window"},"order":"tabsRemovedThenWindowRemoved"}
action 4: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-restored-window-tabs-then-abrupt
Action 4: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-restored-window-tabs-then-abrupt: native restored window tabs then abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-tabs-then-window"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-tabs-then-window"},"order":"tabsRemovedThenWindowRemoved"}
action 4: {"type":"restartBackgroundAbrupt"}
```

### RT-151 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-restored-multitab-window-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:13:03.963Z
- Trace id: `jh-native-restored-multitab-window-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-restored-multitab-window-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-restored-multitab-window-abrupt: native restored multitab window abrupt
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"jh-native-restored-multitab-extra"}
action 2: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-multitab-window"}
action 4: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-multitab-window"},"order":"windowRemovedOnly"}
action 5: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-restored-multitab-window-abrupt
Action 5: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-restored-multitab-window-abrupt: native restored multitab window abrupt
action 1: {"type":"openTab","window":{"windowId":20},"active":false,"captureTab":"jh-native-restored-multitab-extra"}
action 2: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 3: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-multitab-window"}
action 4: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-multitab-window"},"order":"windowRemovedOnly"}
action 5: {"type":"restartBackgroundAbrupt"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T15:13:05.088Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-native-restored-tab-abrupt","runs":366,"processRuns":85,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":24,"duplicateFailures":22,"newFindings":2} -->

### RT-152 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-restored-window-window-then-tabs-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:15:23.904Z
- Trace id: `jh-native-restored-window-window-then-tabs-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-restored-window-window-then-tabs-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-restored-window-window-then-tabs-abrupt: native restored window window then tabs abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-window-first"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-window-first"},"order":"windowRemovedThenTabsRemoved"}
action 4: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-restored-window-window-then-tabs-abrupt
Action 4: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-restored-window-window-then-tabs-abrupt: native restored window window then tabs abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-window-first"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-window-first"},"order":"windowRemovedThenTabsRemoved"}
action 4: {"type":"restartBackgroundAbrupt"}
```

### RT-153 expected closed node window:20 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: jh-native-restored-window-tabs-only-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:15:25.049Z
- Trace id: `jh-native-restored-window-tabs-only-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-restored-window-tabs-only-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-restored-window-tabs-only-abrupt: native restored window tabs only abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-tabs-only-window"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-tabs-only-window"},"order":"tabsRemovedOnly"}
action 4: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-restored-window-tabs-only-abrupt
Action 4: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-restored-window-tabs-only-abrupt: native restored window tabs only abrupt
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredWindows":"jh-native-restored-tabs-only-window"}
action 3: {"type":"nativeCloseWindow","window":{"capture":"jh-native-restored-tabs-only-window"},"order":"tabsRemovedOnly"}
action 4: {"type":"restartBackgroundAbrupt"}
```

### RT-154 native-deleted node tab:2 was resurrected
<!-- signature: native-deleted node tab:<id> was resurrected
domain trace: jh-native-restored-tab-abrupt
action: {"type":"restartBackgroundAbrupt"} -->

- First seen: 2026-05-24T15:55:07.001Z
- Trace id: `jh-native-restored-tab-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=jh-native-restored-tab-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in lifecycle journal durability pass and promoted to regression coverage.

```text
domain trace jh-native-restored-tab-abrupt: native restored tab abrupt
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"jh-native-restored-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"jh-native-restored-tab"},"order":"tabRemovedOnly"}
action 4: {"type":"restartBackgroundAbrupt"}
Domain trace: jh-native-restored-tab-abrupt
Action 4: {"type":"restartBackgroundAbrupt"}
Trace:
domain trace jh-native-restored-tab-abrupt: native restored tab abrupt
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"jh-native-restored-tab"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"jh-native-restored-tab"},"order":"tabRemovedOnly"}
action 4: {"type":"restartBackgroundAbrupt"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T15:15:25.051Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-native-restored-window-tabs-only-abrupt","runs":368,"processRuns":87,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":26,"duplicateFailures":24,"newFindings":2} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:18:08.605Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-delete-leaf-abrupt-refresh-control","runs":372,"processRuns":91,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":26,"duplicateFailures":26,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:21:02.662Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-native-tab-session-abrupt","runs":376,"processRuns":95,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":26,"duplicateFailures":26,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:23:59.625Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-delete-window-abrupt-missing-survivor-control","runs":379,"processRuns":98,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":26,"duplicateFailures":26,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:24:37.507Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","known-finding","manual-refresh","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"hh-restored-tab-native-stale-history","runs":166,"processRuns":4,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:54:38.809Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"jh-native-restored-window-tabs-only-abrupt","runs":192,"processRuns":4,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T15:59:20.960Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"jh-native-restored-tab-abrupt","runs":193,"processRuns":4,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:23:01.418Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"jh-native-restored-tab-abrupt","runs":193,"processRuns":4,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:23:31.892Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"jh-delete-window-abrupt-missing-survivor-control","runs":352,"processRuns":18,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-155 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-existing-refresh
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-existing-old"} -->

- First seen: 2026-05-24T18:26:46.799Z
- Trace id: `nh-native-move-existing-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-existing-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-existing-refresh: native move existing refresh
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-existing-old"}
Domain trace: nh-native-move-existing-refresh
Action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-existing-old"}
Trace:
domain trace nh-native-move-existing-refresh: native move existing refresh
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-existing-old"}
```

### RT-156 tab 100 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-opener-child-refresh
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-move-opener-child"},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-opener-old"} -->

- First seen: 2026-05-24T18:26:50.359Z
- Trace id: `nh-native-move-opener-child-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-opener-child-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-opener-child-refresh: native move opener child refresh
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"nh-move-opener-child"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-move-opener-child"},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-opener-old"}
Domain trace: nh-native-move-opener-child-refresh
Action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-move-opener-child"},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-opener-old"}
Trace:
domain trace nh-native-move-opener-child-refresh: native move opener child refresh
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"nh-move-opener-child"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-move-opener-child"},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-opener-old"}
```

### RT-157 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-close-tab-stale
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-close-tab-old"} -->

- First seen: 2026-05-24T18:26:52.735Z
- Trace id: `nh-native-move-close-tab-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-close-tab-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-close-tab-stale: native move close tab stale
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-close-tab-old"}
Domain trace: nh-native-move-close-tab-stale
Action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-close-tab-old"}
Trace:
domain trace nh-native-move-close-tab-stale: native move close tab stale
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-close-tab-old"}
```

### RT-158 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-close-destination-window
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-destination-close-old"} -->

- First seen: 2026-05-24T18:26:53.935Z
- Trace id: `nh-native-move-close-destination-window`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-close-destination-window pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-close-destination-window: native move close destination window
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-destination-close-old"}
Domain trace: nh-native-move-close-destination-window
Action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-destination-close-old"}
Trace:
domain trace nh-native-move-close-destination-window: native move close destination window
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-destination-close-old"}
```

### RT-159 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-close-source-window
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-source-close-old"} -->

- First seen: 2026-05-24T18:26:55.118Z
- Trace id: `nh-native-move-close-source-window`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-close-source-window pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-close-source-window: native move close source window
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"nh-source-close-extra"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-source-close-old"}
Domain trace: nh-native-move-close-source-window
Action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-source-close-old"}
Trace:
domain trace nh-native-move-close-source-window: native move close source window
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"nh-source-close-extra"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"active":false,"captureStaleTabs":"nh-move-source-close-old"}
```

### RT-160 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-session-only-close
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-session-only-old"} -->

- First seen: 2026-05-24T18:26:56.331Z
- Trace id: `nh-native-move-session-only-close`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-session-only-close pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-session-only-close: native move session only close
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-session-only-old"}
Domain trace: nh-native-move-session-only-close
Action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-session-only-old"}
Trace:
domain trace nh-native-move-session-only-close: native move session only close
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-session-only-old"}
```

### RT-161 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-restart-refresh
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-restart-old"} -->

- First seen: 2026-05-24T18:26:57.507Z
- Trace id: `nh-native-move-restart-refresh`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-restart-refresh pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-restart-refresh: native move restart refresh
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-restart-old"}
Domain trace: nh-native-move-restart-refresh
Action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-restart-old"}
Trace:
domain trace nh-native-move-restart-refresh: native move restart refresh
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-restart-old"}
```

### RT-162 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-native-move-reordered-destination
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-reordered-old"} -->

- First seen: 2026-05-24T18:27:03.494Z
- Trace id: `nh-native-move-reordered-destination`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-move-reordered-destination pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-move-reordered-destination: native move reordered destination
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-reordered-old"}
Domain trace: nh-native-move-reordered-destination
Action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-reordered-old"}
Trace:
domain trace nh-native-move-reordered-destination: native move reordered destination
action 1: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-move-reordered-old"}
```

### RT-163 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-history-undo-native-move
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-history-undo-move-old"} -->

- First seen: 2026-05-24T18:27:07.031Z
- Trace id: `nh-history-undo-native-move`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-history-undo-native-move pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-history-undo-native-move: history undo native move
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-history-undo-move-old"}
Domain trace: nh-history-undo-native-move
Action 3: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-history-undo-move-old"}
Trace:
domain trace nh-history-undo-native-move: history undo native move
action 1: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 2: {"type":"outlinerUndo"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"captureStaleTabs":"nh-history-undo-move-old"}
```

### RT-164 tab 4 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: nh-restored-tab-native-move
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-restored-tab"},"window":{"windowId":20},"captureStaleTabs":"nh-restored-tab-move-old"} -->

- First seen: 2026-05-24T18:27:09.431Z
- Trace id: `nh-restored-tab-native-move`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-restored-tab-native-move pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-restored-tab-native-move: restored tab native move
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"tab:2"},"captureRestoredTabs":"nh-restored-tab"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-restored-tab"},"window":{"windowId":20},"captureStaleTabs":"nh-restored-tab-move-old"}
Domain trace: nh-restored-tab-native-move
Action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-restored-tab"},"window":{"windowId":20},"captureStaleTabs":"nh-restored-tab-move-old"}
Trace:
domain trace nh-restored-tab-native-move: restored tab native move
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"tab:2"},"captureRestoredTabs":"nh-restored-tab"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"nh-restored-tab"},"window":{"windowId":20},"captureStaleTabs":"nh-restored-tab-move-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T18:27:10.609Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-restored-window-native-open-sibling","runs":376,"processRuns":55,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":10,"duplicateFailures":0,"newFindings":10} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:31:01.709Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-move-new-window-restart-missing-destination","runs":384,"processRuns":60,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":10,"duplicateFailures":10,"newFindings":0} -->

### RT-165 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: nh-native-open-id-gap-history-restart
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T18:33:55.584Z
- Trace id: `nh-native-open-id-gap-history-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-open-id-gap-history-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-open-id-gap-history-restart: native open id gap history restart
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native gap A"}],"captureWindow":"nh-id-gap-window-a","captureTabs":"nh-id-gap-tabs-a"}
action 2: {"type":"nativeOpenWindow","tabs":[{"title":"Native gap B"}],"captureWindow":"nh-id-gap-window-b","captureTabs":"nh-id-gap-tabs-b"}
action 3: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 4: {"type":"outlinerUndo"}
Domain trace: nh-native-open-id-gap-history-restart
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace nh-native-open-id-gap-history-restart: native open id gap history restart
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native gap A"}],"captureWindow":"nh-id-gap-window-a","captureTabs":"nh-id-gap-tabs-a"}
action 2: {"type":"nativeOpenWindow","tabs":[{"title":"Native gap B"}],"captureWindow":"nh-id-gap-window-b","captureTabs":"nh-id-gap-tabs-b"}
action 3: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 4: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T18:33:55.586Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-open-id-gap-history-restart","runs":392,"processRuns":72,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":11,"duplicateFailures":10,"newFindings":1} -->

### RT-166 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: nh-native-open-single-history-undo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T18:36:13.457Z
- Trace id: `nh-native-open-single-history-undo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-open-single-history-undo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-open-single-history-undo: native open single history undo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native single history"}],"captureWindow":"nh-history-single-window","captureTabs":"nh-history-single-tabs"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 3: {"type":"outlinerUndo"}
Domain trace: nh-native-open-single-history-undo
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace nh-native-open-single-history-undo: native open single history undo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native single history"}],"captureWindow":"nh-history-single-window","captureTabs":"nh-history-single-tabs"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 3: {"type":"outlinerUndo"}
```

### RT-167 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: nh-native-open-multitab-history-undo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T18:36:14.609Z
- Trace id: `nh-native-open-multitab-history-undo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-open-multitab-history-undo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-open-multitab-history-undo: native open multitab history undo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native history A"},{"title":"Native history B","active":true}],"captureWindow":"nh-history-multitab-window","captureTabs":"nh-history-multitab-tabs"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 3: {"type":"outlinerUndo"}
Domain trace: nh-native-open-multitab-history-undo
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace nh-native-open-multitab-history-undo: native open multitab history undo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native history A"},{"title":"Native history B","active":true}],"captureWindow":"nh-history-multitab-window","captureTabs":"nh-history-multitab-tabs"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 3: {"type":"outlinerUndo"}
```

### RT-168 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: nh-native-open-history-group-redo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T18:36:18.114Z
- Trace id: `nh-native-open-history-group-redo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-open-history-group-redo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-open-history-group-redo: native open history group redo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native redo history"}],"captureWindow":"nh-history-redo-window","captureTabs":"nh-history-redo-tabs"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 3: {"type":"outlinerUndo"}
Domain trace: nh-native-open-history-group-redo
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace nh-native-open-history-group-redo: native open history group redo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native redo history"}],"captureWindow":"nh-history-redo-window","captureTabs":"nh-history-redo-tabs"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 3: {"type":"outlinerUndo"}
```

### RT-169 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: nh-native-open-history-session-undo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T18:36:19.284Z
- Trace id: `nh-native-open-history-session-undo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-open-history-session-undo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-open-history-session-undo: native open history session undo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native session history"}],"captureWindow":"nh-history-session-window","captureTabs":"nh-history-session-tabs"}
action 2: {"type":"sessionChanged"}
action 3: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 4: {"type":"outlinerUndo"}
Domain trace: nh-native-open-history-session-undo
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace nh-native-open-history-session-undo: native open history session undo
action 1: {"type":"nativeOpenWindow","tabs":[{"title":"Native session history"}],"captureWindow":"nh-history-session-window","captureTabs":"nh-history-session-tabs"}
action 2: {"type":"sessionChanged"}
action 3: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 4: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T18:36:19.286Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-open-history-session-undo","runs":398,"processRuns":78,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":15,"duplicateFailures":11,"newFindings":4} -->

### RT-170 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: nh-native-detach-group-undo
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-24T18:39:25.061Z
- Trace id: `nh-native-detach-group-undo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=nh-native-detach-group-undo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed in browser-authored drift fix pass and promoted to regression coverage.

```text
domain trace nh-native-detach-group-undo: native detach group undo
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"nh-detach-group-filler"}
action 2: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":2},"captureWindow":"nh-detach-group-window","captureStaleTabs":"nh-detach-group-old"}
action 3: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 4: {"type":"outlinerUndo"}
Domain trace: nh-native-detach-group-undo
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace nh-native-detach-group-undo: native detach group undo
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"captureTab":"nh-detach-group-filler"}
action 2: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":2},"captureWindow":"nh-detach-group-window","captureStaleTabs":"nh-detach-group-old"}
action 3: {"type":"outlinerGroupTab","tab":{"tabId":1}}
action 4: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T18:39:28.524Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-detach-abrupt-session-refresh","runs":404,"processRuns":85,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":16,"duplicateFailures":15,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:42:20.083Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-open-opener-focus-reordered","runs":409,"processRuns":90,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:45:11.406Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-open-close-reject-tab-session","runs":414,"processRuns":95,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:48:13.302Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"nh-native-open-opener-close-child-stale","runs":419,"processRuns":100,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T18:48:49.280Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"jh-native-restored-tab-abrupt","runs":193,"processRuns":4,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:06:45.815Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"nh-native-detach-group-undo","runs":209,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:08:57.607Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"nh-native-detach-group-undo","runs":209,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:21:12.490Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"nh-native-detach-group-undo","runs":209,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-171 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: mh-grouped-sibling-reorder-history
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-grouped-order-sibling"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-grouped-order-old"} -->

- First seen: 2026-05-24T19:28:49.378Z
- Trace id: `mh-grouped-sibling-reorder-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-grouped-sibling-reorder-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-grouped-sibling-reorder-history: grouped sibling reorder history
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"title":"Grouped order sibling","captureTab":"mh-grouped-order-sibling"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"mh-grouped-order-before"}
action 3: {"type":"outlinerUndo"}
action 4: {"type":"outlinerRedo"}
action 5: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-grouped-order-sibling"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-grouped-order-old"}
Domain trace: mh-grouped-sibling-reorder-history
Action 5: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-grouped-order-sibling"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-grouped-order-old"}
Trace:
domain trace mh-grouped-sibling-reorder-history: grouped sibling reorder history
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"title":"Grouped order sibling","captureTab":"mh-grouped-order-sibling"}
action 2: {"type":"outlinerGroupTab","tab":{"tabId":1},"captureStaleTabs":"mh-grouped-order-before"}
action 3: {"type":"outlinerUndo"}
action 4: {"type":"outlinerRedo"}
action 5: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-grouped-order-sibling"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-grouped-order-old"}
```

### RT-172 runtime tab order for window 10 matches outline preorder
<!-- signature: runtime tab order for window <id> matches outline preorder
domain trace: mh-native-multitab-move-one-out
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-multitab-tabs","index":1},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-multitab-move-old"} -->

- First seen: 2026-05-24T19:29:08.457Z
- Trace id: `mh-native-multitab-move-one-out`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-native-multitab-move-one-out pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-native-multitab-move-one-out: native multitab move one out
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Multi A"},{"title":"Multi B"},{"title":"Multi C","active":true}],"captureWindow":"mh-multitab-window","captureTabs":"mh-multitab-tabs"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-multitab-tabs","index":1},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-multitab-move-old"}
Domain trace: mh-native-multitab-move-one-out
Action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-multitab-tabs","index":1},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-multitab-move-old"}
Trace:
domain trace mh-native-multitab-move-one-out: native multitab move one out
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Multi A"},{"title":"Multi B"},{"title":"Multi C","active":true}],"captureWindow":"mh-multitab-window","captureTabs":"mh-multitab-tabs"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-multitab-tabs","index":1},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-multitab-move-old"}
```

### RT-173 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: mh-restart-nested-reorder-missing
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-restart-nested-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":false,"captureStaleTabs":"mh-restart-nested-reorder-old"} -->

- First seen: 2026-05-24T19:29:09.593Z
- Trace id: `mh-restart-nested-reorder-missing`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-restart-nested-reorder-missing pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-restart-nested-reorder-missing: restart nested reorder missing
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":2},"captureStaleTabs":"mh-restart-nested-old"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"Restart nested sibling","captureTab":"mh-restart-nested-sibling"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-restart-nested-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":false,"captureStaleTabs":"mh-restart-nested-reorder-old"}
Domain trace: mh-restart-nested-reorder-missing
Action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-restart-nested-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":false,"captureStaleTabs":"mh-restart-nested-reorder-old"}
Trace:
domain trace mh-restart-nested-reorder-missing: restart nested reorder missing
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":2},"captureStaleTabs":"mh-restart-nested-old"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"Restart nested sibling","captureTab":"mh-restart-nested-sibling"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-restart-nested-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":false,"captureStaleTabs":"mh-restart-nested-reorder-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T19:29:09.594Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-restart-nested-reorder-missing","runs":425,"processRuns":47,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":3,"duplicateFailures":0,"newFindings":3} -->

### RT-174 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: mh-active-fallback-same-window-reorder
action: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-active-fallback-old"} -->

- First seen: 2026-05-24T19:31:37.357Z
- Trace id: `mh-active-fallback-same-window-reorder`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-active-fallback-same-window-reorder pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-active-fallback-same-window-reorder: active fallback same window reorder
action 1: {"type":"activateTab","tab":{"tabId":2}}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-active-fallback-old"}
Domain trace: mh-active-fallback-same-window-reorder
Action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-active-fallback-old"}
Trace:
domain trace mh-active-fallback-same-window-reorder: active fallback same window reorder
action 1: {"type":"activateTab","tab":{"tabId":2}}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-active-fallback-old"}
```

### RT-175 runtime tab order for window 10 matches outline preorder
<!-- signature: runtime tab order for window <id> matches outline preorder
domain trace: mh-order-native-open-move-front
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-front-tabs","index":1},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-order-front-old"} -->

- First seen: 2026-05-24T19:31:40.728Z
- Trace id: `mh-order-native-open-move-front`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-order-native-open-move-front pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-order-native-open-move-front: order native open move front
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Move front A"},{"title":"Move front B","active":true}],"captureWindow":"mh-order-front-window","captureTabs":"mh-order-front-tabs"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-front-tabs","index":1},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-order-front-old"}
Domain trace: mh-order-native-open-move-front
Action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-front-tabs","index":1},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-order-front-old"}
Trace:
domain trace mh-order-native-open-move-front: order native open move front
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Move front A"},{"title":"Move front B","active":true}],"captureWindow":"mh-order-front-window","captureTabs":"mh-order-front-tabs"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-front-tabs","index":1},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-order-front-old"}
```

### RT-176 runtime tab order for window 10 matches outline preorder
<!-- signature: runtime tab order for window <id> matches outline preorder
domain trace: mh-order-native-open-move-middle-session
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-middle-tabs"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-middle-old"} -->

- First seen: 2026-05-24T19:31:41.851Z
- Trace id: `mh-order-native-open-move-middle-session`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-order-native-open-move-middle-session pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-order-native-open-move-middle-session: order native open move middle session
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"title":"Middle target filler","captureTab":"mh-order-middle-filler"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Move middle A"},{"title":"Move middle B","active":true}],"captureWindow":"mh-order-middle-window","captureTabs":"mh-order-middle-tabs"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-middle-tabs"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-middle-old"}
Domain trace: mh-order-native-open-move-middle-session
Action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-middle-tabs"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-middle-old"}
Trace:
domain trace mh-order-native-open-move-middle-session: order native open move middle session
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"title":"Middle target filler","captureTab":"mh-order-middle-filler"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Move middle A"},{"title":"Move middle B","active":true}],"captureWindow":"mh-order-middle-window","captureTabs":"mh-order-middle-tabs"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-order-middle-tabs"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-middle-old"}
```

### RT-177 tab 1 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: mh-order-command-destination-move-out
action: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-command-move-old"} -->

- First seen: 2026-05-24T19:31:42.997Z
- Trace id: `mh-order-command-destination-move-out`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-order-command-destination-move-out pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-order-command-destination-move-out: order command destination move out
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"mh-order-command-old"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"Command order sibling","captureTab":"mh-order-command-sibling"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-command-move-old"}
Domain trace: mh-order-command-destination-move-out
Action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-command-move-old"}
Trace:
domain trace mh-order-command-destination-move-out: order command destination move out
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"mh-order-command-old"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"Command order sibling","captureTab":"mh-order-command-sibling"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-order-command-move-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T19:31:45.242Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-metadata-native-created-stale-refresh","runs":433,"processRuns":55,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":7,"duplicateFailures":3,"newFindings":4} -->

### RT-178 tab 2 has wrong live window
<!-- signature: tab <id> has wrong live window
domain trace: mh-command-destination-move-out-restart
action: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-command-out-restart-move-old"} -->

- First seen: 2026-05-24T19:34:13.979Z
- Trace id: `mh-command-destination-move-out-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-command-destination-move-out-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-command-destination-move-out-restart: command destination move out restart
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":2},"captureStaleTabs":"mh-command-out-restart-old"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"Command out restart sibling","captureTab":"mh-command-out-restart-sibling"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-command-out-restart-move-old"}
Domain trace: mh-command-destination-move-out-restart
Action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-command-out-restart-move-old"}
Trace:
domain trace mh-command-destination-move-out-restart: command destination move out restart
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":2},"captureStaleTabs":"mh-command-out-restart-old"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"Command out restart sibling","captureTab":"mh-command-out-restart-sibling"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-command-out-restart-move-old"}
```

### RT-179 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: mh-command-destination-move-out-stale
action: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-command-out-stale-destination-old"} -->

- First seen: 2026-05-24T19:34:15.204Z
- Trace id: `mh-command-destination-move-out-stale`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-command-destination-move-out-stale pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-command-destination-move-out-stale: command destination move out stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"mh-command-out-stale-source-old"}
action 2: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"Before move back","url":"https://move-back.example/before"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-command-out-stale-destination-old"}
Domain trace: mh-command-destination-move-out-stale
Action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-command-out-stale-destination-old"}
Trace:
domain trace mh-command-destination-move-out-stale: command destination move out stale
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"mh-command-out-stale-source-old"}
action 2: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"Before move back","url":"https://move-back.example/before"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":1,"active":false,"captureStaleTabs":"mh-command-out-stale-destination-old"}
```

### RT-180 runtime tab order for window 10 matches outline preorder
<!-- signature: runtime tab order for window <id> matches outline preorder
domain trace: mh-native-detach-move-back-history
action: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-detach-back-destination-old"} -->

- First seen: 2026-05-24T19:34:16.421Z
- Trace id: `mh-native-detach-move-back-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-native-detach-move-back-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-native-detach-move-back-history: native detach move back history
action 1: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":2},"captureWindow":"mh-detach-back-window","captureStaleTabs":"mh-detach-back-old"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-detach-back-destination-old"}
Domain trace: mh-native-detach-move-back-history
Action 2: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-detach-back-destination-old"}
Trace:
domain trace mh-native-detach-move-back-history: native detach move back history
action 1: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":2},"captureWindow":"mh-detach-back-window","captureStaleTabs":"mh-detach-back-old"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"role":"lastMovedTab"},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"mh-detach-back-destination-old"}
```

### RT-181 runtime tab order for window 22 matches outline preorder
<!-- signature: runtime tab order for window <id> matches outline preorder
domain trace: mh-order-two-window-swap
action: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-swap-tabs-a"},"window":{"capture":"mh-swap-window-b"},"index":1,"active":false,"captureStaleTabs":"mh-swap-a-old"} -->

- First seen: 2026-05-24T19:34:19.987Z
- Trace id: `mh-order-two-window-swap`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-order-two-window-swap pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-order-two-window-swap: order two window swap
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Swap A1"},{"title":"Swap A2","active":true}],"captureWindow":"mh-swap-window-a","captureTabs":"mh-swap-tabs-a"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Swap B1"},{"title":"Swap B2","active":true}],"captureWindow":"mh-swap-window-b","captureTabs":"mh-swap-tabs-b"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-swap-tabs-a"},"window":{"capture":"mh-swap-window-b"},"index":1,"active":false,"captureStaleTabs":"mh-swap-a-old"}
Domain trace: mh-order-two-window-swap
Action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-swap-tabs-a"},"window":{"capture":"mh-swap-window-b"},"index":1,"active":false,"captureStaleTabs":"mh-swap-a-old"}
Trace:
domain trace mh-order-two-window-swap: order two window swap
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Swap A1"},{"title":"Swap A2","active":true}],"captureWindow":"mh-swap-window-a","captureTabs":"mh-swap-tabs-a"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"Swap B1"},{"title":"Swap B2","active":true}],"captureWindow":"mh-swap-window-b","captureTabs":"mh-swap-tabs-b"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"capture":"mh-swap-tabs-a"},"window":{"capture":"mh-swap-window-b"},"index":1,"active":false,"captureStaleTabs":"mh-swap-a-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T19:34:19.988Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-order-two-window-swap","runs":439,"processRuns":61,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":11,"duplicateFailures":7,"newFindings":4} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:37:14.640Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-paired-browser-created-close-metadata","runs":443,"processRuns":63,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:39:33.767Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-nested-window-metadata-focus","runs":447,"processRuns":63,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":11,"duplicateFailures":11,"newFindings":0} -->

### RT-182 tab 4 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: mh-delayed-restored-tab-updated-echo
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-delayed-restored-tab"},"withStaleQuery":true} -->

- First seen: 2026-05-24T19:42:25.139Z
- Trace id: `mh-delayed-restored-tab-updated-echo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-delayed-restored-tab-updated-echo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-delayed-restored-tab-updated-echo: delayed restored tab updated echo
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-delayed-restored-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-delayed-restored-tab"},"title":"Delayed Restored Current","url":"https://delayed-restored.example/"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-delayed-restored-tab"},"withStaleQuery":true}
Domain trace: mh-delayed-restored-tab-updated-echo
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-delayed-restored-tab"},"withStaleQuery":true}
Trace:
domain trace mh-delayed-restored-tab-updated-echo: delayed restored tab updated echo
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-delayed-restored-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-delayed-restored-tab"},"title":"Delayed Restored Current","url":"https://delayed-restored.example/"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-delayed-restored-tab"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T19:42:26.350Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-opener-native-move-metadata-restart","runs":451,"processRuns":74,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":12,"duplicateFailures":11,"newFindings":1} -->

### RT-183 tab 4 url metadata diverged
<!-- signature: tab <id> url metadata diverged
domain trace: mh-restored-tab-created-echo-metadata
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"mh-restored-created-meta-tab"},"withStaleQuery":true} -->

- First seen: 2026-05-24T19:45:01.172Z
- Trace id: `mh-restored-tab-created-echo-metadata`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-restored-tab-created-echo-metadata pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-restored-tab-created-echo-metadata: restored tab created echo metadata
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-restored-created-meta-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-created-meta-tab"},"title":"Restored Created Current","url":"https://restored-created.example/"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"mh-restored-created-meta-tab"},"withStaleQuery":true}
Domain trace: mh-restored-tab-created-echo-metadata
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"mh-restored-created-meta-tab"},"withStaleQuery":true}
Trace:
domain trace mh-restored-tab-created-echo-metadata: restored tab created echo metadata
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-restored-created-meta-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-created-meta-tab"},"title":"Restored Created Current","url":"https://restored-created.example/"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"mh-restored-created-meta-tab"},"withStaleQuery":true}
```

### RT-184 tab 3 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: mh-restored-window-tab-updated-echo
action: {"type":"updateTab","tab":{"capture":"mh-restored-window-meta-tabs"},"title":"Restored Window Current","url":"https://restored-window-meta.example/"} -->

- First seen: 2026-05-24T19:45:02.450Z
- Trace id: `mh-restored-window-tab-updated-echo`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-restored-window-tab-updated-echo pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-restored-window-tab-updated-echo: restored window tab updated echo
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredTabs":"mh-restored-window-meta-tabs","captureRestoredWindows":"mh-restored-window-meta-window"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-window-meta-tabs"},"title":"Restored Window Current","url":"https://restored-window-meta.example/"}
Domain trace: mh-restored-window-tab-updated-echo
Action 3: {"type":"updateTab","tab":{"capture":"mh-restored-window-meta-tabs"},"title":"Restored Window Current","url":"https://restored-window-meta.example/"}
Trace:
domain trace mh-restored-window-tab-updated-echo: restored window tab updated echo
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"window:20"},"captureRestoredTabs":"mh-restored-window-meta-tabs","captureRestoredWindows":"mh-restored-window-meta-window"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-window-meta-tabs"},"title":"Restored Window Current","url":"https://restored-window-meta.example/"}
```

### RT-185 tab 4 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: mh-restored-tab-restart-stale-metadata
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-restart-meta-tab"},"withStaleQuery":true} -->

- First seen: 2026-05-24T19:45:03.846Z
- Trace id: `mh-restored-tab-restart-stale-metadata`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-restored-tab-restart-stale-metadata pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-restored-tab-restart-stale-metadata: restored tab restart stale metadata
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-restored-restart-meta-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-restart-meta-tab"},"title":"Restored Restart Current","url":"https://restored-restart.example/"}
action 4: {"type":"restartBackground"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-restart-meta-tab"},"withStaleQuery":true}
Domain trace: mh-restored-tab-restart-stale-metadata
Action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-restart-meta-tab"},"withStaleQuery":true}
Trace:
domain trace mh-restored-tab-restart-stale-metadata: restored tab restart stale metadata
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-restored-restart-meta-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-restart-meta-tab"},"title":"Restored Restart Current","url":"https://restored-restart.example/"}
action 4: {"type":"restartBackground"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-restart-meta-tab"},"withStaleQuery":true}
```

### RT-186 tab 4 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: mh-restored-tab-missing-query-metadata
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-missing-meta-tab"},"withStaleQuery":true} -->

- First seen: 2026-05-24T19:45:05.063Z
- Trace id: `mh-restored-tab-missing-query-metadata`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=mh-restored-tab-missing-query-metadata pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime shape fact pass and promoted to regression coverage.

```text
domain trace mh-restored-tab-missing-query-metadata: restored tab missing query metadata
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-restored-missing-meta-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-missing-meta-tab"},"title":"Restored Missing Current","url":"https://restored-missing.example/"}
action 4: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"mh-restored-missing-meta-tab"}}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-missing-meta-tab"},"withStaleQuery":true}
Domain trace: mh-restored-tab-missing-query-metadata
Action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-missing-meta-tab"},"withStaleQuery":true}
Trace:
domain trace mh-restored-tab-missing-query-metadata: restored tab missing query metadata
action 1: {"type":"outlinerCloseTab","tab":{"tabId":2}}
action 2: {"type":"outlinerRestoreNodeRejectingCreate","node":{"nodeId":"tab:2"},"captureRestoredTabs":"mh-restored-missing-meta-tab"}
action 3: {"type":"updateTab","tab":{"capture":"mh-restored-missing-meta-tab"},"title":"Restored Missing Current","url":"https://restored-missing.example/"}
action 4: {"type":"manualRefreshWithMissingTabQuery","tab":{"capture":"mh-restored-missing-meta-tab"}}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"mh-restored-missing-meta-tab"},"withStaleQuery":true}
```

<!-- hunt-corpus-run: {"at":"2026-05-24T19:45:05.065Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-restored-tab-missing-query-metadata","runs":455,"processRuns":78,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":16,"duplicateFailures":12,"newFindings":4} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:47:38.254Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-control-opener-metadata-partial","runs":457,"processRuns":80,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:49:57.791Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-control-paired-nonrestored-echo","runs":459,"processRuns":82,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:52:27.860Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"mh-control-partial-query-current-metadata","runs":461,"processRuns":84,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":16,"duplicateFailures":16,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T19:53:56.823Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"nh-native-detach-group-undo","runs":209,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T22:11:26.529Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo"],"firstTraceId":"rt-active-race","lastTraceId":"nh-native-detach-group-undo","runs":209,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T22:12:24.341Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"mh-restored-tab-missing-query-metadata","runs":225,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-24T22:16:07.240Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"mh-restored-tab-missing-query-metadata","runs":225,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T08:30:20.865Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"ur-external-window-tabs-only-close-stale-echo","runs":226,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

## Fix Analysis: Runtime Window Scope Routing

- Root cause: externally created resources that had already become closed outline records had no live close plan when the user deleted them, so the durable lifecycle journal skipped the pending delete. If the background died before the state save, startup could reconstruct the closed runtime record from storage and resurrect the command-deleted node.
- Fix: added an ephemeral `RuntimeWindowScopeIndex` behind `RuntimeFactLedger`, reconstructed from outline/runtime evidence, and made delete journaling treat closed scoped/tombstoned runtime rows as lifecycle work even when there is no browser close left to perform. Scope policy now also exposes restored/browser-created provenance to reconciliation for current-window shape decisions.
- Coverage: promoted `oh-external-closed-delete-restart-history` as RT-187 and `oh-external-closed-delete-tab-abrupt-history` as RT-190. Duplicate discovery traces RT-191 through RT-198 remain historical evidence and passed the temp discovery smoke.
- Perf blast radius: runtime event routing, restore, native close, delete, refresh. `pnpm perf:runtime-guard` passed after keeping scope rebuilds off no-op refresh and compact command/event patch paths; no budget movement accepted.

### RT-187 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-restart-history
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T08:56:25.284Z
- Trace id: `oh-external-closed-delete-restart-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-restart-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime window scope routing plus empty-plan delete journaling for closed scoped runtime records; promoted to regression coverage.

```text
domain trace oh-external-closed-delete-restart-history: external closed delete restart history
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete restart"}],"captureWindow":"oh-delete-restart-window","captureTabs":"oh-delete-restart-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-restart-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-restart-history
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-restart-history: external closed delete restart history
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete restart"}],"captureWindow":"oh-delete-restart-window","captureTabs":"oh-delete-restart-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-restart-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T08:56:39.734Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["created-event","delete-rejection","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested-window","opener","restart","restore","session","stale-event","stale-query","undo-redo","updated-event"],"firstTraceId":"oh-external-closed-restore-single","lastTraceId":"oh-external-id-gaps-closed-restore","runs":20,"processRuns":21,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-188 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-opener-session-only-close
action: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T08:58:42.214Z
- Trace id: `dh-opener-session-only-close`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-opener-session-only-close pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: harness artifact, not a product finding. This was caused by an overbroad temporary harness expectation that treated every last-tab `sessionChangedOnly` event as a preserved closed window; narrowed to browser-created external windows only.

```text
domain trace dh-opener-session-only-close: opener-linked relocation with session-only tab removal
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"session-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"session-opener-child"},"captureStaleTabs":"session-opener-old-window"}
action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Domain trace: dh-opener-session-only-close
Action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Trace:
domain trace dh-opener-session-only-close: opener-linked relocation with session-only tab removal
action 1: {"type":"openTab","window":{"windowId":10},"active":false,"openerTab":{"tabId":1},"captureTab":"session-opener-child"}
action 2: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"capture":"session-opener-child"},"captureStaleTabs":"session-opener-old-window"}
action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
```

### RT-189 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: dh-session-only-close-manual-stale-query
action: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T08:59:07.975Z
- Trace id: `dh-session-only-close-manual-stale-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=dh-session-only-close-manual-stale-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: harness artifact, not a product finding. This was caused by an overbroad temporary harness expectation that treated every last-tab `sessionChangedOnly` event as a preserved closed window; narrowed to browser-created external windows only.

```text
domain trace dh-session-only-close-manual-stale-query: session-only moved tab close before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"session-only-manual-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Domain trace: dh-session-only-close-manual-stale-query
Action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Trace:
domain trace dh-session-only-close-manual-stale-query: session-only moved tab close before manual stale query
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"session-only-manual-old"}
action 2: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
```

### RT-190 command-deleted node tab:100 was resurrected
<!-- signature: command-deleted node tab:<id> was resurrected
domain trace: oh-external-closed-delete-tab-abrupt-history
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:<id>"}} -->

- First seen: 2026-05-25T09:00:23.568Z
- Trace id: `oh-external-closed-delete-tab-abrupt-history`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-tab-abrupt-history pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by runtime window scope routing plus empty-plan delete journaling for closed scoped runtime records; promoted to regression coverage.

```text
domain trace oh-external-closed-delete-tab-abrupt-history: external closed delete tab abrupt history
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete tab abrupt"}],"captureWindow":"oh-delete-tab-abrupt-window","captureTabs":"oh-delete-tab-abrupt-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-tab-abrupt-window"},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:100"}}
Domain trace: oh-external-closed-delete-tab-abrupt-history
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:100"}}
Trace:
domain trace oh-external-closed-delete-tab-abrupt-history: external closed delete tab abrupt history
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete tab abrupt"}],"captureWindow":"oh-delete-tab-abrupt-window","captureTabs":"oh-delete-tab-abrupt-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-tab-abrupt-window"},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:100"}}
```

### RT-191 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-window-abrupt-window-only
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:00:24.912Z
- Trace id: `oh-external-closed-delete-window-abrupt-window-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-window-abrupt-window-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-closed-delete-window-abrupt-window-only: external closed delete window abrupt window only
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete window-only"}],"captureWindow":"oh-delete-window-only-window","captureTabs":"oh-delete-window-only-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-window-only-window"},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-window-abrupt-window-only
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-window-abrupt-window-only: external closed delete window abrupt window only
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete window-only"}],"captureWindow":"oh-delete-window-only-window","captureTabs":"oh-delete-window-only-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-window-only-window"},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

### RT-192 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-window-abrupt-tabs-only
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:00:26.186Z
- Trace id: `oh-external-closed-delete-window-abrupt-tabs-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-window-abrupt-tabs-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-closed-delete-window-abrupt-tabs-only: external closed delete window abrupt tabs only
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete tabs-only"}],"captureWindow":"oh-delete-tabs-only-window","captureTabs":"oh-delete-tabs-only-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-tabs-only-window"},"order":"tabsRemovedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-window-abrupt-tabs-only
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-window-abrupt-tabs-only: external closed delete window abrupt tabs only
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete tabs-only"}],"captureWindow":"oh-delete-tabs-only-window","captureTabs":"oh-delete-tabs-only-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-tabs-only-window"},"order":"tabsRemovedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

### RT-193 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-multitab-abrupt
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:00:27.429Z
- Trace id: `oh-external-closed-delete-multitab-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-multitab-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-closed-delete-multitab-abrupt: external closed delete multitab abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete multi A"},{"title":"External delete multi B","active":true}],"captureWindow":"oh-delete-multi-window","captureTabs":"oh-delete-multi-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-multi-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-multitab-abrupt
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-multitab-abrupt: external closed delete multitab abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete multi A"},{"title":"External delete multi B","active":true}],"captureWindow":"oh-delete-multi-window","captureTabs":"oh-delete-multi-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-multi-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

### RT-194 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-session-abrupt
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:00:28.644Z
- Trace id: `oh-external-closed-delete-session-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-session-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-closed-delete-session-abrupt: external closed delete session abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete session"}],"captureWindow":"oh-delete-session-window","captureTabs":"oh-delete-session-tabs"}
action 2: {"type":"nativeCloseTab","tab":{"capture":"oh-delete-session-tabs"},"order":"sessionChangedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-session-abrupt
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-session-abrupt: external closed delete session abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete session"}],"captureWindow":"oh-delete-session-window","captureTabs":"oh-delete-session-tabs"}
action 2: {"type":"nativeCloseTab","tab":{"capture":"oh-delete-session-tabs"},"order":"sessionChangedOnly"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

### RT-195 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-after-restart-abrupt
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:00:29.860Z
- Trace id: `oh-external-closed-delete-after-restart-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-after-restart-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-closed-delete-after-restart-abrupt: external closed delete after restart abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete after restart"}],"captureWindow":"oh-delete-after-restart-window","captureTabs":"oh-delete-after-restart-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-after-restart-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-after-restart-abrupt
Action 4: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-after-restart-abrupt: external closed delete after restart abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete after restart"}],"captureWindow":"oh-delete-after-restart-window","captureTabs":"oh-delete-after-restart-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-after-restart-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

### RT-196 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-restored-then-closed-delete-abrupt
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:00:31.094Z
- Trace id: `oh-external-restored-then-closed-delete-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-restored-then-closed-delete-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-restored-then-closed-delete-abrupt: external restored then closed delete abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External restore close delete"}],"captureWindow":"oh-restore-close-delete-window","captureTabs":"oh-restore-close-delete-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-restore-close-delete-window"},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:21"},"captureRestoredTabs":"oh-restore-close-delete-restored-tabs","captureRestoredWindows":"oh-restore-close-delete-restored-window"}
action 4: {"type":"nativeCloseWindow","window":{"capture":"oh-restore-close-delete-restored-window"},"order":"tabsRemovedThenWindowRemoved"}
action 5: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-restored-then-closed-delete-abrupt
Action 5: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-restored-then-closed-delete-abrupt: external restored then closed delete abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External restore close delete"}],"captureWindow":"oh-restore-close-delete-window","captureTabs":"oh-restore-close-delete-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-restore-close-delete-window"},"order":"windowRemovedOnly"}
action 3: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:21"},"captureRestoredTabs":"oh-restore-close-delete-restored-tabs","captureRestoredWindows":"oh-restore-close-delete-restored-window"}
action 4: {"type":"nativeCloseWindow","window":{"capture":"oh-restore-close-delete-restored-window"},"order":"tabsRemovedThenWindowRemoved"}
action 5: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T09:00:32.332Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"oh-external-closed-delete-redo-after-abrupt","runs":473,"processRuns":97,"batchSize":20,"batchFailures":4,"completedCorpus":true,"failures":10,"duplicateFailures":1,"newFindings":9} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T09:05:00.639Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"oh-external-closed-restore-delete-history-redo","runs":479,"processRuns":63,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":8,"duplicateFailures":8,"newFindings":0} -->

### RT-197 command-deleted node tab:100 was resurrected
<!-- signature: command-deleted node tab:<id> was resurrected
domain trace: oh-external-opener-child-delete-tab-abrupt
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:<id>"}} -->

- First seen: 2026-05-25T09:07:52.105Z
- Trace id: `oh-external-opener-child-delete-tab-abrupt`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-opener-child-delete-tab-abrupt pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-190 external closed-tab delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-opener-child-delete-tab-abrupt: external opener child delete tab abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External opener delete abrupt","openerTab":{"tabId":1}}],"captureWindow":"oh-opener-delete-abrupt-window","captureTabs":"oh-opener-delete-abrupt-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-opener-delete-abrupt-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:100"}}
Domain trace: oh-external-opener-child-delete-tab-abrupt
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:100"}}
Trace:
domain trace oh-external-opener-child-delete-tab-abrupt: external opener child delete tab abrupt
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External opener delete abrupt","openerTab":{"tabId":1}}],"captureWindow":"oh-opener-delete-abrupt-window","captureTabs":"oh-opener-delete-abrupt-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-opener-delete-abrupt-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"tab:100"}}
```

### RT-198 command-deleted node window:21 was resurrected
<!-- signature: command-deleted node window:<id> was resurrected
domain trace: oh-external-closed-delete-window-abrupt-stale-created
action: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:<id>"}} -->

- First seen: 2026-05-25T09:07:54.450Z
- Trace id: `oh-external-closed-delete-window-abrupt-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=oh-external-closed-delete-window-abrupt-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate repro evidence for the RT-187 external closed-window delete crash-recovery bug; covered by the runtime window scope routing fix and preserved as historical evidence.

```text
domain trace oh-external-closed-delete-window-abrupt-stale-created: external closed delete window abrupt stale created
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete stale created"}],"captureWindow":"oh-delete-stale-created-window","captureTabs":"oh-delete-stale-created-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-stale-created-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Domain trace: oh-external-closed-delete-window-abrupt-stale-created
Action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
Trace:
domain trace oh-external-closed-delete-window-abrupt-stale-created: external closed delete window abrupt stale created
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"External delete stale created"}],"captureWindow":"oh-delete-stale-created-window","captureTabs":"oh-delete-stale-created-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"oh-delete-stale-created-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerDeleteNodeThenAbruptRestart","node":{"nodeId":"window:21"}}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T09:07:59.114Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"oh-external-nested-restore-after-group-close","runs":485,"processRuns":70,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":10,"duplicateFailures":8,"newFindings":2} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T09:11:24.285Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"oh-external-restored-close-history-redo","runs":489,"processRuns":74,"batchSize":20,"batchFailures":3,"completedCorpus":true,"failures":10,"duplicateFailures":10,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T09:12:02.955Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"ur-external-window-tabs-only-close-stale-echo","runs":226,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T09:59:29.156Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"oh-external-closed-delete-tab-abrupt-history","runs":228,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T10:02:20.979Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"oh-external-closed-delete-tab-abrupt-history","runs":228,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T10:24:03.630Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"oh-external-closed-delete-tab-abrupt-history","runs":228,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-199 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: wh-saved-session-only-disappear
action: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T10:24:49.593Z
- Trace id: `wh-saved-session-only-disappear`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=wh-saved-session-only-disappear pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by session-only missing-scope corroboration; promoted to regression coverage.

```text
domain trace wh-saved-session-only-disappear: saved session only disappear
action 1: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"}
Domain trace: wh-saved-session-only-disappear
Action 1: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"}
Trace:
domain trace wh-saved-session-only-disappear: saved session only disappear
action 1: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T10:25:01.581Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"wh-focus-active-race-scopes","runs":512,"processRuns":38,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-200 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: wh-saved-session-only-after-restart
action: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T10:27:30.016Z
- Trace id: `wh-saved-session-only-after-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=wh-saved-session-only-after-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by session-only missing-scope corroboration after scope reconstruction; promoted to regression coverage.

```text
domain trace wh-saved-session-only-after-restart: saved session only after restart
action 1: {"type":"restartBackground"}
action 2: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"}
Domain trace: wh-saved-session-only-after-restart
Action 2: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"}
Trace:
domain trace wh-saved-session-only-after-restart: saved session only after restart
action 1: {"type":"restartBackground"}
action 2: {"type":"nativeCloseTab","tab":{"tabId":3},"order":"sessionChangedOnly"}
```

### RT-201 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: wh-restored-window-session-only-disappear
action: {"type":"nativeCloseTab","tab":{"capture":"wh-restored-window-session-tabs"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T10:27:33.846Z
- Trace id: `wh-restored-window-session-only-disappear`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=wh-restored-window-session-only-disappear pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by session-only missing-scope corroboration for restored scopes; promoted to regression coverage.

```text
domain trace wh-restored-window-session-only-disappear: restored window session only disappear
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:20"},"captureRestoredTabs":"wh-restored-window-session-tabs","captureRestoredWindows":"wh-restored-window-session-window"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"wh-restored-window-session-tabs"},"order":"sessionChangedOnly"}
Domain trace: wh-restored-window-session-only-disappear
Action 3: {"type":"nativeCloseTab","tab":{"capture":"wh-restored-window-session-tabs"},"order":"sessionChangedOnly"}
Trace:
domain trace wh-restored-window-session-only-disappear: restored window session only disappear
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:20"},"captureRestoredTabs":"wh-restored-window-session-tabs","captureRestoredWindows":"wh-restored-window-session-window"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"wh-restored-window-session-tabs"},"order":"sessionChangedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T10:27:46.425Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"wh-focus-active-race-scopes","runs":516,"processRuns":42,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":3,"duplicateFailures":1,"newFindings":2} -->

### RT-202 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: wh-command-session-only-after-restart
action: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T10:30:20.983Z
- Trace id: `wh-command-session-only-after-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=wh-command-session-only-after-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by durable command-created runtime provenance plus session-only missing-scope deletion policy; promoted to regression coverage.

```text
domain trace wh-command-session-only-after-restart: command session only after restart
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"wh-command-session-restart-old"}
action 2: {"type":"restartBackground"}
action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Domain trace: wh-command-session-only-after-restart
Action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
Trace:
domain trace wh-command-session-only-after-restart: command session only after restart
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"wh-command-session-restart-old"}
action 2: {"type":"restartBackground"}
action 3: {"type":"nativeCloseTab","tab":{"role":"lastMovedTab"},"order":"sessionChangedOnly"}
```

### RT-203 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: wh-browser-created-session-only-after-restart
action: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-session-restart-tabs"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T10:30:24.603Z
- Trace id: `wh-browser-created-session-only-after-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=wh-browser-created-session-only-after-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by durable browser-created runtime provenance plus session-only missing-scope close policy; promoted to regression coverage.

```text
domain trace wh-browser-created-session-only-after-restart: browser created session only after restart
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"WH Browser session restart"}],"captureWindow":"wh-browser-session-restart-window","captureTabs":"wh-browser-session-restart-tabs"}
action 2: {"type":"restartBackground"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-session-restart-tabs"},"order":"sessionChangedOnly"}
Domain trace: wh-browser-created-session-only-after-restart
Action 3: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-session-restart-tabs"},"order":"sessionChangedOnly"}
Trace:
domain trace wh-browser-created-session-only-after-restart: browser created session only after restart
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"WH Browser session restart"}],"captureWindow":"wh-browser-session-restart-window","captureTabs":"wh-browser-session-restart-tabs"}
action 2: {"type":"restartBackground"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-session-restart-tabs"},"order":"sessionChangedOnly"}
```

### RT-204 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: wh-browser-restored-session-only-disappear
action: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-restored-session-current-tabs"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T10:30:25.812Z
- Trace id: `wh-browser-restored-session-only-disappear`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=wh-browser-restored-session-only-disappear pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by browser-created/restored scope reconstruction plus session-only missing-scope close policy; promoted to regression coverage.

```text
domain trace wh-browser-restored-session-only-disappear: browser restored session only disappear
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"WH Browser restored session"}],"captureWindow":"wh-browser-restored-session-window","captureTabs":"wh-browser-restored-session-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"wh-browser-restored-session-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:21"},"captureRestoredTabs":"wh-browser-restored-session-current-tabs","captureRestoredWindows":"wh-browser-restored-session-current-window"}
action 4: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-restored-session-current-tabs"},"order":"sessionChangedOnly"}
Domain trace: wh-browser-restored-session-only-disappear
Action 4: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-restored-session-current-tabs"},"order":"sessionChangedOnly"}
Trace:
domain trace wh-browser-restored-session-only-disappear: browser restored session only disappear
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"WH Browser restored session"}],"captureWindow":"wh-browser-restored-session-window","captureTabs":"wh-browser-restored-session-tabs"}
action 2: {"type":"nativeCloseWindow","window":{"capture":"wh-browser-restored-session-window"},"order":"tabsRemovedThenWindowRemoved"}
action 3: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:21"},"captureRestoredTabs":"wh-browser-restored-session-current-tabs","captureRestoredWindows":"wh-browser-restored-session-current-window"}
action 4: {"type":"nativeCloseTab","tab":{"capture":"wh-browser-restored-session-current-tabs"},"order":"sessionChangedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T10:30:48.305Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"wh-focus-active-race-scopes","runs":520,"processRuns":66,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":6,"duplicateFailures":3,"newFindings":3} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T10:33:19.740Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"wh-focus-active-race-scopes","runs":524,"processRuns":67,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":6,"duplicateFailures":6,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T10:35:28.152Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"wh-focus-active-race-scopes","runs":526,"processRuns":67,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":6,"duplicateFailures":6,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T10:37:22.802Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"wh-focus-active-race-scopes","runs":528,"processRuns":47,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":6,"duplicateFailures":6,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T10:38:03.882Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","command-rejection","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event"],"firstTraceId":"rt-active-race","lastTraceId":"oh-external-closed-delete-tab-abrupt-history","runs":228,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T11:17:37.409Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"wh-browser-restored-session-only-disappear","runs":234,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T11:44:57.211Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"wh-browser-restored-session-only-disappear","runs":234,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-205 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: sh-saved-reorder-metadata-stale-pair
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-reorder-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:46:04.852Z
- Trace id: `sh-saved-reorder-metadata-stale-pair`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-saved-reorder-metadata-stale-pair pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-saved-reorder-metadata-stale-pair: saved reorder metadata stale pair
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Reorder Current","url":"https://sh.example/saved-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-reorder-before"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-reorder-before"},"withStaleQuery":false}
Domain trace: sh-saved-reorder-metadata-stale-pair
Action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-reorder-before"},"withStaleQuery":false}
Trace:
domain trace sh-saved-reorder-metadata-stale-pair: saved reorder metadata stale pair
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Reorder Current","url":"https://sh.example/saved-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-reorder-before"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-reorder-before"},"withStaleQuery":false}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T11:46:07.504Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":544,"processRuns":48,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-206 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: sh-saved-reorder-restart-stale-created
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-restart-reorder-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:48:35.225Z
- Trace id: `sh-saved-reorder-restart-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-saved-reorder-restart-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-saved-reorder-restart-stale-created: saved reorder restart stale created
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Restart Reorder Current","url":"https://sh.example/saved-restart-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-restart-reorder-before"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-restart-reorder-before"},"withStaleQuery":false}
Domain trace: sh-saved-reorder-restart-stale-created
Action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-restart-reorder-before"},"withStaleQuery":false}
Trace:
domain trace sh-saved-reorder-restart-stale-created: saved reorder restart stale created
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Restart Reorder Current","url":"https://sh.example/saved-restart-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-restart-reorder-before"}
action 3: {"type":"restartBackground"}
action 4: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-restart-reorder-before"},"withStaleQuery":false}
```

### RT-207 tab 100 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: sh-command-destination-reorder-current-stale-created
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-command-current-reorder-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:48:40.521Z
- Trace id: `sh-command-destination-reorder-current-stale-created`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-command-destination-reorder-current-stale-created pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-command-destination-reorder-current-stale-created: command destination reorder current stale created
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"sh-command-current-reorder-old-source"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"SH command current reorder sibling","captureTab":"sh-command-current-reorder-sibling"}
action 3: {"type":"updateTab","tab":{"capture":"sh-command-current-reorder-sibling"},"title":"SH Command Current Reorder","url":"https://sh.example/command-current-reorder"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"capture":"sh-command-current-reorder-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":true,"captureStaleTabs":"sh-command-current-reorder-before"}
action 5: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-command-current-reorder-before"},"withStaleQuery":false}
Domain trace: sh-command-destination-reorder-current-stale-created
Action 5: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-command-current-reorder-before"},"withStaleQuery":false}
Trace:
domain trace sh-command-destination-reorder-current-stale-created: command destination reorder current stale created
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"sh-command-current-reorder-old-source"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"SH command current reorder sibling","captureTab":"sh-command-current-reorder-sibling"}
action 3: {"type":"updateTab","tab":{"capture":"sh-command-current-reorder-sibling"},"title":"SH Command Current Reorder","url":"https://sh.example/command-current-reorder"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"capture":"sh-command-current-reorder-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":true,"captureStaleTabs":"sh-command-current-reorder-before"}
action 5: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-command-current-reorder-before"},"withStaleQuery":false}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T11:48:47.045Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":548,"processRuns":56,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":3,"duplicateFailures":1,"newFindings":2} -->

### RT-208 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: sh-saved-reorder-stale-updated-active
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-updated-reorder-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:51:05.925Z
- Trace id: `sh-saved-reorder-stale-updated-active`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-saved-reorder-stale-updated-active pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-saved-reorder-stale-updated-active: saved reorder stale updated active
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Updated Reorder Current","url":"https://sh.example/saved-updated-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-updated-reorder-before"}
action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-updated-reorder-before"},"withStaleQuery":false}
Domain trace: sh-saved-reorder-stale-updated-active
Action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-updated-reorder-before"},"withStaleQuery":false}
Trace:
domain trace sh-saved-reorder-stale-updated-active: saved reorder stale updated active
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Updated Reorder Current","url":"https://sh.example/saved-updated-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-updated-reorder-before"}
action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-updated-reorder-before"},"withStaleQuery":false}
```

### RT-209 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: sh-saved-reorder-stale-created-with-query
action: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-query-reorder-before"},"withStaleQuery":true} -->

- First seen: 2026-05-25T11:51:07.148Z
- Trace id: `sh-saved-reorder-stale-created-with-query`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-saved-reorder-stale-created-with-query pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-saved-reorder-stale-created-with-query: saved reorder stale created with query
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Query Reorder Current","url":"https://sh.example/saved-query-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-query-reorder-before"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-query-reorder-before"},"withStaleQuery":true}
Domain trace: sh-saved-reorder-stale-created-with-query
Action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-query-reorder-before"},"withStaleQuery":true}
Trace:
domain trace sh-saved-reorder-stale-created-with-query: saved reorder stale created with query
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Query Reorder Current","url":"https://sh.example/saved-query-reorder"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":true,"captureStaleTabs":"sh-saved-query-reorder-before"}
action 3: {"type":"staleLiveCreatedEvent","staleTab":{"capture":"sh-saved-query-reorder-before"},"withStaleQuery":true}
```

### RT-210 tab 100 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: sh-command-destination-reorder-stale-updated-active
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-updated-reorder-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:51:08.918Z
- Trace id: `sh-command-destination-reorder-stale-updated-active`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-command-destination-reorder-stale-updated-active pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-command-destination-reorder-stale-updated-active: command destination reorder stale updated active
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"sh-command-updated-reorder-old-source"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"SH command updated reorder sibling","captureTab":"sh-command-updated-reorder-sibling"}
action 3: {"type":"updateTab","tab":{"capture":"sh-command-updated-reorder-sibling"},"title":"SH Command Updated Reorder","url":"https://sh.example/command-updated-reorder"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"capture":"sh-command-updated-reorder-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":true,"captureStaleTabs":"sh-command-updated-reorder-before"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-updated-reorder-before"},"withStaleQuery":false}
Domain trace: sh-command-destination-reorder-stale-updated-active
Action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-updated-reorder-before"},"withStaleQuery":false}
Trace:
domain trace sh-command-destination-reorder-stale-updated-active: command destination reorder stale updated active
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"sh-command-updated-reorder-old-source"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"SH command updated reorder sibling","captureTab":"sh-command-updated-reorder-sibling"}
action 3: {"type":"updateTab","tab":{"capture":"sh-command-updated-reorder-sibling"},"title":"SH Command Updated Reorder","url":"https://sh.example/command-updated-reorder"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"capture":"sh-command-updated-reorder-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":true,"captureStaleTabs":"sh-command-updated-reorder-before"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-updated-reorder-before"},"withStaleQuery":false}
```

### RT-211 tab 101 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: sh-browser-created-reorder-stale-updated-active
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-browser-updated-reorder-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:51:10.349Z
- Trace id: `sh-browser-created-reorder-stale-updated-active`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-browser-created-reorder-stale-updated-active pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-browser-created-reorder-stale-updated-active: browser created reorder stale updated active
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"SH browser updated reorder A"},{"title":"SH browser updated reorder B","active":true}],"captureWindow":"sh-browser-updated-reorder-window","captureTabs":"sh-browser-updated-reorder-tabs"}
action 2: {"type":"updateTab","tab":{"inWindow":{"capture":"sh-browser-updated-reorder-window"},"index":1},"title":"SH Browser Updated Reorder","url":"https://sh.example/browser-updated-reorder"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"sh-browser-updated-reorder-window"},"index":1},"window":{"capture":"sh-browser-updated-reorder-window"},"index":0,"active":true,"captureStaleTabs":"sh-browser-updated-reorder-before"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-browser-updated-reorder-before"},"withStaleQuery":false}
Domain trace: sh-browser-created-reorder-stale-updated-active
Action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-browser-updated-reorder-before"},"withStaleQuery":false}
Trace:
domain trace sh-browser-created-reorder-stale-updated-active: browser created reorder stale updated active
action 1: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"SH browser updated reorder A"},{"title":"SH browser updated reorder B","active":true}],"captureWindow":"sh-browser-updated-reorder-window","captureTabs":"sh-browser-updated-reorder-tabs"}
action 2: {"type":"updateTab","tab":{"inWindow":{"capture":"sh-browser-updated-reorder-window"},"index":1},"title":"SH Browser Updated Reorder","url":"https://sh.example/browser-updated-reorder"}
action 3: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"sh-browser-updated-reorder-window"},"index":1},"window":{"capture":"sh-browser-updated-reorder-window"},"index":0,"active":true,"captureStaleTabs":"sh-browser-updated-reorder-before"}
action 4: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-browser-updated-reorder-before"},"withStaleQuery":false}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T11:51:16.628Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":552,"processRuns":60,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":7,"duplicateFailures":3,"newFindings":4} -->

### RT-212 tab 2 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: sh-saved-reorder-stale-updated-metadata-only
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-metadata-only-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:53:47.380Z
- Trace id: `sh-saved-reorder-stale-updated-metadata-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-saved-reorder-stale-updated-metadata-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-saved-reorder-stale-updated-metadata-only: saved reorder stale updated metadata only
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Metadata Only Current","url":"https://sh.example/saved-metadata-only"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"sh-saved-metadata-only-before"}
action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-metadata-only-before"},"withStaleQuery":false}
Domain trace: sh-saved-reorder-stale-updated-metadata-only
Action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-metadata-only-before"},"withStaleQuery":false}
Trace:
domain trace sh-saved-reorder-stale-updated-metadata-only: saved reorder stale updated metadata only
action 1: {"type":"updateTab","tab":{"tabId":2},"title":"SH Saved Metadata Only Current","url":"https://sh.example/saved-metadata-only"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":10},"index":0,"active":false,"captureStaleTabs":"sh-saved-metadata-only-before"}
action 3: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-saved-metadata-only-before"},"withStaleQuery":false}
```

### RT-213 tab 100 title metadata diverged
<!-- signature: tab <id> title metadata diverged
domain trace: sh-command-reorder-stale-updated-metadata-only
action: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-metadata-only-before"},"withStaleQuery":false} -->

- First seen: 2026-05-25T11:53:48.564Z
- Trace id: `sh-command-reorder-stale-updated-metadata-only`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=sh-command-reorder-stale-updated-metadata-only pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace sh-command-reorder-stale-updated-metadata-only: command reorder stale updated metadata only
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"sh-command-metadata-only-old-source"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"SH command metadata only sibling","captureTab":"sh-command-metadata-only-sibling"}
action 3: {"type":"updateTab","tab":{"capture":"sh-command-metadata-only-sibling"},"title":"SH Command Metadata Only Current","url":"https://sh.example/command-metadata-only"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"capture":"sh-command-metadata-only-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":false,"captureStaleTabs":"sh-command-metadata-only-before"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-metadata-only-before"},"withStaleQuery":false}
Domain trace: sh-command-reorder-stale-updated-metadata-only
Action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-metadata-only-before"},"withStaleQuery":false}
Trace:
domain trace sh-command-reorder-stale-updated-metadata-only: command reorder stale updated metadata only
action 1: {"type":"outlinerMoveTabCommandToNewWindow","tab":{"tabId":1},"captureStaleTabs":"sh-command-metadata-only-old-source"}
action 2: {"type":"openTab","window":{"role":"lastOpenedWindow"},"active":false,"title":"SH command metadata only sibling","captureTab":"sh-command-metadata-only-sibling"}
action 3: {"type":"updateTab","tab":{"capture":"sh-command-metadata-only-sibling"},"title":"SH Command Metadata Only Current","url":"https://sh.example/command-metadata-only"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"capture":"sh-command-metadata-only-sibling"},"window":{"role":"lastOpenedWindow"},"index":0,"active":false,"captureStaleTabs":"sh-command-metadata-only-before"}
action 5: {"type":"staleLiveUpdatedEvent","staleTab":{"capture":"sh-command-metadata-only-before"},"withStaleQuery":false}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T11:53:56.847Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":556,"processRuns":64,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":9,"duplicateFailures":7,"newFindings":2} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T11:57:18.281Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":560,"processRuns":68,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":9,"duplicateFailures":9,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T11:59:44.469Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":562,"processRuns":69,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":9,"duplicateFailures":9,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T12:02:06.486Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sh-restart-stale-generation-after-live-edit","runs":564,"processRuns":69,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":9,"duplicateFailures":9,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T12:02:36.476Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"wh-browser-restored-session-only-disappear","runs":234,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T12:04:38.203Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"wh-browser-restored-session-only-disappear","runs":234,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T12:47:43.116Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"sh-command-reorder-stale-updated-metadata-only","runs":243,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T13:05:11.647Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"sh-command-reorder-stale-updated-metadata-only","runs":243,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T13:07:50.824Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"sh-command-reorder-stale-updated-metadata-only","runs":243,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:21:07.266Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"sh-command-reorder-stale-updated-metadata-only","runs":243,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:22:03.865Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-restore-delete-around-fullscreen","runs":579,"processRuns":29,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:23:47.867Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-restored-minimized-fullscreen-stale-created","runs":582,"processRuns":30,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:25:14.768Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-saved-fullscreen-native-reorder","runs":585,"processRuns":30,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-214 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: fh-abrupt-restart-fullscreen-session-close
action: {"type":"nativeCloseTab","tab":{"capture":"fh-abrupt-session-tabs"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T14:26:44.260Z
- Trace id: `fh-abrupt-restart-fullscreen-session-close`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=fh-abrupt-restart-fullscreen-session-close pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace fh-abrupt-restart-fullscreen-session-close: abrupt restart fullscreen session close
action 1: {"type":"nativeOpenWindow","focused":true,"tabs":[{"title":"FH abrupt session close","active":true}],"captureWindow":"fh-abrupt-session-window","captureTabs":"fh-abrupt-session-tabs"}
action 2: {"type":"nativeSetWindowState","window":{"capture":"fh-abrupt-session-window"},"state":"fullscreen"}
action 3: {"type":"restartBackgroundAbrupt"}
action 4: {"type":"nativeCloseTab","tab":{"capture":"fh-abrupt-session-tabs"},"order":"sessionChangedOnly"}
Domain trace: fh-abrupt-restart-fullscreen-session-close
Action 4: {"type":"nativeCloseTab","tab":{"capture":"fh-abrupt-session-tabs"},"order":"sessionChangedOnly"}
Trace:
domain trace fh-abrupt-restart-fullscreen-session-close: abrupt restart fullscreen session close
action 1: {"type":"nativeOpenWindow","focused":true,"tabs":[{"title":"FH abrupt session close","active":true}],"captureWindow":"fh-abrupt-session-window","captureTabs":"fh-abrupt-session-tabs"}
action 2: {"type":"nativeSetWindowState","window":{"capture":"fh-abrupt-session-window"},"state":"fullscreen"}
action 3: {"type":"restartBackgroundAbrupt"}
action 4: {"type":"nativeCloseTab","tab":{"capture":"fh-abrupt-session-tabs"},"order":"sessionChangedOnly"}
```

### RT-215 No movable live-tab command candidate for runtime tab 3
<!-- signature: No movable live-tab command candidate for runtime tab <id>
domain trace: fh-restored-fullscreen-history-restart
action: {"type":"outlinerGroupTab","tab":{"capture":"fh-history-restored-tabs"},"captureStaleTabs":"fh-history-restored-old"} -->

- First seen: 2026-05-25T14:26:46.715Z
- Trace id: `fh-restored-fullscreen-history-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=fh-restored-fullscreen-history-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed/triaged and promoted to regression coverage.

```text
domain trace fh-restored-fullscreen-history-restart: restored fullscreen history restart
action 1: {"type":"outlinerCloseWindow","window":{"windowId":20}}
action 2: {"type":"outlinerRestoreNodeThenAbruptRestart","node":{"nodeId":"window:20"},"captureRestoredTabs":"fh-history-restored-tabs","captureRestoredWindows":"fh-history-restored-window"}
action 3: {"type":"nativeSetWindowState","window":{"capture":"fh-history-restored-window"},"state":"fullscreen"}
action 4: {"type":"updateTab","tab":{"capture":"fh-history-restored-tabs"},"title":"FH history restored current","url":"https://fh.example/history-restored"}
action 5: {"type":"outlinerGroupTab","tab":{"capture":"fh-history-restored-tabs"},"captureStaleTabs":"fh-history-restored-old"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T14:26:46.716Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-restored-fullscreen-history-restart","runs":588,"processRuns":38,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":2,"duplicateFailures":0,"newFindings":2} -->

### RT-216 expected closed node window:21 is missing
<!-- signature: expected closed node window:<id> is missing
domain trace: fh-abrupt-restart-normal-session-close-control
action: {"type":"nativeCloseTab","tab":{"capture":"fh-normal-session-tabs"},"order":"sessionChangedOnly"} -->

- First seen: 2026-05-25T14:28:48.906Z
- Trace id: `fh-abrupt-restart-normal-session-close-control`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=fh-abrupt-restart-normal-session-close-control pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed and promoted to regression coverage.

```text
domain trace fh-abrupt-restart-normal-session-close-control: abrupt restart normal session close control
action 1: {"type":"nativeOpenWindow","focused":true,"tabs":[{"title":"FH normal session close","active":true}],"captureWindow":"fh-normal-session-window","captureTabs":"fh-normal-session-tabs"}
action 2: {"type":"restartBackgroundAbrupt"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"fh-normal-session-tabs"},"order":"sessionChangedOnly"}
Domain trace: fh-abrupt-restart-normal-session-close-control
Action 3: {"type":"nativeCloseTab","tab":{"capture":"fh-normal-session-tabs"},"order":"sessionChangedOnly"}
Trace:
domain trace fh-abrupt-restart-normal-session-close-control: abrupt restart normal session close control
action 1: {"type":"nativeOpenWindow","focused":true,"tabs":[{"title":"FH normal session close","active":true}],"captureWindow":"fh-normal-session-window","captureTabs":"fh-normal-session-tabs"}
action 2: {"type":"restartBackgroundAbrupt"}
action 3: {"type":"nativeCloseTab","tab":{"capture":"fh-normal-session-tabs"},"order":"sessionChangedOnly"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T14:28:51.455Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-restored-fullscreen-child-history-restart","runs":591,"processRuns":41,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":3,"duplicateFailures":2,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:30:48.602Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-abrupt-restart-restored-session-close-control","runs":594,"processRuns":44,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":3,"duplicateFailures":3,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:37:29.075Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-command-fullscreen-source-close-abrupt","runs":597,"processRuns":47,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":3,"duplicateFailures":3,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:39:21.220Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history-boundary","journal","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"fh-restored-fullscreen-windowremoved-clean","runs":600,"processRuns":50,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":3,"duplicateFailures":3,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T14:40:39.496Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope"],"firstTraceId":"rt-active-race","lastTraceId":"sh-command-reorder-stale-updated-metadata-only","runs":243,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T15:08:34.848Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"fh-abrupt-restart-normal-session-close-control","runs":246,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T15:25:56.384Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"fh-abrupt-restart-normal-session-close-control","runs":246,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-217 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: xh-history-undo-after-native-move
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-25T15:28:17.832Z
- Trace id: `xh-history-undo-after-native-move`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=xh-history-undo-after-native-move pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by the history replay runtime-shape overlay pass.

```text
domain trace xh-history-undo-after-native-move: history undo after native move
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"xh-history-move-group-old"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"index":0,"active":true,"captureStaleTabs":"xh-history-move-old"}
action 3: {"type":"outlinerUndo"}
Domain trace: xh-history-undo-after-native-move
Action 3: {"type":"outlinerUndo"}
Trace:
domain trace xh-history-undo-after-native-move: history undo after native move
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"xh-history-move-group-old"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"index":0,"active":true,"captureStaleTabs":"xh-history-move-old"}
action 3: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T15:28:36.666Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"xh-browser-close-history-missing-query","runs":624,"processRuns":52,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-218 tab 2 active flag diverged
<!-- signature: tab <id> active flag diverged
domain trace: xh-history-undo-after-native-move-restart
action: {"type":"outlinerUndo"} -->

- First seen: 2026-05-25T15:30:42.641Z
- Trace id: `xh-history-undo-after-native-move-restart`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=xh-history-undo-after-native-move-restart pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by the history replay runtime-shape overlay pass.

```text
domain trace xh-history-undo-after-native-move-restart: history undo after native move restart
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"xh-history-restart-group-old"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"index":0,"active":true,"captureStaleTabs":"xh-history-restart-move-old"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
Domain trace: xh-history-undo-after-native-move-restart
Action 4: {"type":"outlinerUndo"}
Trace:
domain trace xh-history-undo-after-native-move-restart: history undo after native move restart
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"xh-history-restart-group-old"}
action 2: {"type":"nativeMoveTabToWindow","tab":{"tabId":2},"window":{"windowId":20},"index":0,"active":true,"captureStaleTabs":"xh-history-restart-move-old"}
action 3: {"type":"restartBackground"}
action 4: {"type":"outlinerUndo"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T15:30:58.274Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"xh-browser-close-history-missing-query","runs":628,"processRuns":52,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":2,"duplicateFailures":1,"newFindings":1} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T15:33:07.344Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"xh-browser-close-history-missing-query","runs":632,"processRuns":52,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T15:34:58.406Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"xh-browser-close-history-missing-query","runs":636,"processRuns":52,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T15:36:59.767Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"xh-browser-close-history-missing-query","runs":640,"processRuns":52,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":2,"duplicateFailures":2,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T15:37:38.932Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"fh-abrupt-restart-normal-session-close-control","runs":246,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:10:52.126Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"xh-history-undo-after-native-move-restart","runs":248,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:35:39.295Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"xh-history-undo-after-native-move-restart","runs":248,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:36:32.892Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","snapshot-confidence","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"qh-restored-native-move-reordered-survivor","runs":664,"processRuns":34,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:40:10.820Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","snapshot-confidence","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"qh-rung2-restored-delete-reject-stale-reordered","runs":680,"processRuns":34,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:42:29.996Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","snapshot-confidence","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"qh-escape-abrupt-two-browser-windows-skew","runs":688,"processRuns":35,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:42:56.828Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"xh-history-undo-after-native-move-restart","runs":248,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:56:35.615Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","snapshot-confidence","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ra-focus-session-partial-after-restored-update","runs":704,"processRuns":36,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T16:59:09.821Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","snapshot-confidence","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ra-rung1-external-restore-delete-history","runs":712,"processRuns":36,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:03:51.206Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","session","snapshot-confidence","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"ra-escape-restored-opener-native-close-redo","runs":720,"processRuns":36,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:05:08.097Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"xh-history-undo-after-native-move-restart","runs":248,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:11:51.032Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"xh-history-undo-after-native-move-restart","runs":248,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:19:57.466Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sb-restored-fullscreen-external-delete-history","runs":736,"processRuns":37,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

### RT-219 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: ub-redo-journal-after-dual-native-drifts
action: {"type":"outlinerRedoThenAbruptRestart"} -->

- First seen: 2026-05-25T17:24:32.616Z
- Trace id: `ub-redo-journal-after-dual-native-drifts`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=ub-redo-journal-after-dual-native-drifts pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: fixed by history journal materialized-window recovery.

```text
domain trace ub-redo-journal-after-dual-native-drifts: subagent rung1 redo journal after dual native drifts
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"ub-redo-group-old"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UB redo A1"},{"title":"UB redo A2","active":true}],"captureWindow":"ub-redo-window-a","captureTabs":"ub-redo-tabs-a"}
action 3: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UB redo B1","active":true}],"captureWindow":"ub-redo-window-b","captureTabs":"ub-redo-tabs-b"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"ub-redo-window-a"},"index":1},"window":{"capture":"ub-redo-window-b"},"index":0,"active":true,"captureStaleTabs":"ub-redo-a-old"}
action 5: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":1},"active":true,"captureWindow":"ub-redo-detached-window","captureStaleTabs":"ub-redo-detached-old"}
action 6: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"UB Redo Detached Current","url":"https://ub.example/redo-detached"}
action 7: {"type":"outlinerUndo"}
action 8: {"type":"outlinerRedoThenAbruptRestart"}
Domain trace: ub-redo-journal-after-dual-native-drifts
Action 8: {"type":"outlinerRedoThenAbruptRestart"}
Trace:
domain trace ub-redo-journal-after-dual-native-drifts: subagent rung1 redo journal after dual native drifts
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"ub-redo-group-old"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UB redo A1"},{"title":"UB redo A2","active":true}],"captureWindow":"ub-redo-window-a","captureTabs":"ub-redo-tabs-a"}
action 3: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UB redo B1","active":true}],"captureWindow":"ub-redo-window-b","captureTabs":"ub-redo-tabs-b"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"ub-redo-window-a"},"index":1},"window":{"capture":"ub-redo-window-b"},"index":0,"active":true,"captureStaleTabs":"ub-redo-a-old"}
action 5: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":1},"active":true,"captureWindow":"ub-redo-detached-window","captureStaleTabs":"ub-redo-detached-old"}
action 6: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"UB Redo Detached Current","url":"https://ub.example/redo-detached"}
action 7: {"type":"outlinerUndo"}
action 8: {"type":"outlinerRedoThenAbruptRestart"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T17:24:42.820Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["browserCreated","commandCreated","complete-refresh","history","journal","metadata","multi-window","native-close","native-move","partial-snapshot","restart","restore","restored","runtime-order","session","stale-event","subagent"],"firstTraceId":"ub-redo-journal-after-dual-native-drifts","lastTraceId":"sc-complete-refresh-then-stale-restored-order","runs":8,"processRuns":9,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-220 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: uc-redo-journal-dual-drift-complete-before-partial
action: {"type":"outlinerRedoThenAbruptRestart"} -->

- First seen: 2026-05-25T17:29:21.110Z
- Trace id: `uc-redo-journal-dual-drift-complete-before-partial`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=uc-redo-journal-dual-drift-complete-before-partial pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate evidence for RT-219; fixed/covered by history journal materialized-window recovery.

```text
domain trace uc-redo-journal-dual-drift-complete-before-partial: subagent clone redo journal dual drift complete before partial
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"uc-complete-group-old"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC complete A1"},{"title":"UC complete A2","active":true}],"captureWindow":"uc-complete-window-a","captureTabs":"uc-complete-tabs-a"}
action 3: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC complete B1","active":true}],"captureWindow":"uc-complete-window-b","captureTabs":"uc-complete-tabs-b"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"uc-complete-window-a"},"index":1},"window":{"capture":"uc-complete-window-b"},"index":0,"active":true,"captureStaleTabs":"uc-complete-a-old"}
action 5: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":1},"active":true,"captureWindow":"uc-complete-detached-window","captureStaleTabs":"uc-complete-detached-old"}
action 6: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"UC Complete Detached Current","url":"https://uc.example/complete-detached"}
action 7: {"type":"manualRefresh"}
action 8: {"type":"outlinerUndo"}
action 9: {"type":"outlinerRedoThenAbruptRestart"}
Domain trace: uc-redo-journal-dual-drift-complete-before-partial
Action 9: {"type":"outlinerRedoThenAbruptRestart"}
Trace:
domain trace uc-redo-journal-dual-drift-complete-before-partial: subagent clone redo journal dual drift complete before partial
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"uc-complete-group-old"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC complete A1"},{"title":"UC complete A2","active":true}],"captureWindow":"uc-complete-window-a","captureTabs":"uc-complete-tabs-a"}
action 3: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC complete B1","active":true}],"captureWindow":"uc-complete-window-b","captureTabs":"uc-complete-tabs-b"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"uc-complete-window-a"},"index":1},"window":{"capture":"uc-complete-window-b"},"index":0,"active":true,"captureStaleTabs":"uc-complete-a-old"}
action 5: {"type":"nativeMoveTabToNewWindow","tab":{"tabId":1},"active":true,"captureWindow":"uc-complete-detached-window","captureStaleTabs":"uc-complete-detached-old"}
action 6: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"UC Complete Detached Current","url":"https://uc.example/complete-detached"}
action 7: {"type":"manualRefresh"}
action 8: {"type":"outlinerUndo"}
action 9: {"type":"outlinerRedoThenAbruptRestart"}
```

### RT-221 live tab IDs match runtime tabs
<!-- signature: live tab IDs match runtime tabs
domain trace: uc-redo-journal-dual-drift-saved-tab-into-external
action: {"type":"outlinerRedoThenAbruptRestart"} -->

- First seen: 2026-05-25T17:29:22.407Z
- Trace id: `uc-redo-journal-dual-drift-saved-tab-into-external`
- Repro: `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=uc-redo-journal-dual-drift-saved-tab-into-external pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot`
- Status: duplicate evidence for RT-219; fixed/covered by history journal materialized-window recovery.

```text
domain trace uc-redo-journal-dual-drift-saved-tab-into-external: subagent clone redo journal saved tab into external
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"uc-merge-group-old"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC merge A1"},{"title":"UC merge A2","active":true}],"captureWindow":"uc-merge-window-a","captureTabs":"uc-merge-tabs-a"}
action 3: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC merge B1","active":true}],"captureWindow":"uc-merge-window-b","captureTabs":"uc-merge-tabs-b"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"uc-merge-window-a"},"index":1},"window":{"capture":"uc-merge-window-b"},"index":0,"active":true,"captureStaleTabs":"uc-merge-a-old"}
action 5: {"type":"nativeMoveTabToWindow","tab":{"tabId":1},"window":{"capture":"uc-merge-window-b"},"index":1,"active":true,"captureStaleTabs":"uc-merge-saved-old"}
action 6: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"UC Merge Saved Current","url":"https://uc.example/merge-saved"}
action 7: {"type":"outlinerUndo"}
action 8: {"type":"outlinerRedoThenAbruptRestart"}
Domain trace: uc-redo-journal-dual-drift-saved-tab-into-external
Action 8: {"type":"outlinerRedoThenAbruptRestart"}
Trace:
domain trace uc-redo-journal-dual-drift-saved-tab-into-external: subagent clone redo journal saved tab into external
action 1: {"type":"outlinerGroupTab","tab":{"tabId":2},"captureStaleTabs":"uc-merge-group-old"}
action 2: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC merge A1"},{"title":"UC merge A2","active":true}],"captureWindow":"uc-merge-window-a","captureTabs":"uc-merge-tabs-a"}
action 3: {"type":"nativeOpenWindow","focused":false,"tabs":[{"title":"UC merge B1","active":true}],"captureWindow":"uc-merge-window-b","captureTabs":"uc-merge-tabs-b"}
action 4: {"type":"nativeMoveTabToWindow","tab":{"inWindow":{"capture":"uc-merge-window-a"},"index":1},"window":{"capture":"uc-merge-window-b"},"index":0,"active":true,"captureStaleTabs":"uc-merge-a-old"}
action 5: {"type":"nativeMoveTabToWindow","tab":{"tabId":1},"window":{"capture":"uc-merge-window-b"},"index":1,"active":true,"captureStaleTabs":"uc-merge-saved-old"}
action 6: {"type":"updateTab","tab":{"role":"lastMovedTab"},"title":"UC Merge Saved Current","url":"https://uc.example/merge-saved"}
action 7: {"type":"outlinerUndo"}
action 8: {"type":"outlinerRedoThenAbruptRestart"}
```

<!-- hunt-corpus-run: {"at":"2026-05-25T17:29:27.494Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["browserCreated","commandCreated","complete-refresh","history","journal","metadata","multi-window","native-move","partial-snapshot","restored","runtime-order","saved","scope-shape","stale-event","subagent","undo-redo","window-state"],"firstTraceId":"uc-redo-journal-dual-drift-complete-before-partial","lastTraceId":"sd-browser-created-window-state-sparse-shape","runs":6,"processRuns":7,"batchSize":20,"batchFailures":1,"completedCorpus":true,"failures":2,"duplicateFailures":0,"newFindings":2} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:34:46.126Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"se-partial-snapshot-shared-window-missing-survivor","runs":754,"processRuns":72,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":3,"duplicateFailures":3,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:38:16.507Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"se-browser-created-scope-generation-no-journal-stale-metadata","runs":758,"processRuns":76,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":3,"duplicateFailures":3,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:41:39.719Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"sf-cross-window-order-after-complete-stale-metadata","runs":761,"processRuns":79,"batchSize":20,"batchFailures":2,"completedCorpus":true,"failures":3,"duplicateFailures":3,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T17:42:16.451Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"xh-history-undo-after-native-move-restart","runs":248,"processRuns":5,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T18:24:14.666Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"uc-redo-journal-dual-drift-saved-tab-into-external","runs":251,"processRuns":6,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T18:35:08.654Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"uc-redo-journal-dual-drift-saved-tab-into-external","runs":251,"processRuns":6,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T18:41:42.155Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","mixed-provenance","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"yh-two-mixed-windows-exchange-tabs","runs":785,"processRuns":40,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T18:44:54.742Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","mixed-provenance","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"yh-rung1-no-journal-transfer-abrupt-freshness","runs":793,"processRuns":40,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T18:48:20.279Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","mixed-provenance","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"yh-rung2-two-mixed-windows-close-one-partial","runs":800,"processRuns":40,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-25T18:48:56.139Z","mode":"agent-corpus-run","profile":"regression","coverageTags":["activation","breadth","browserCreated","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","history","history-boundary","journal","known-finding","manual-refresh","metadata","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","reconciliation","relocation","restart","restore","restored","restored-scope","runtime-order","saved","session","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"rt-active-race","lastTraceId":"uc-redo-journal-dual-drift-saved-tab-into-external","runs":251,"processRuns":6,"batchSize":50,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->

<!-- hunt-corpus-run: {"at":"2026-05-26T07:34:32.009Z","mode":"agent-corpus-run","profile":"discovery","coverageTags":["activation","breadth","browser-authored","browserCreated","bug-rich","calibration","command-rejection","commandCreated","complete-refresh","created-event","cross-axis","delayed-event","delete","delete-rejection","event-order","focus","fresh-event","fullscreen","group","history","history-boundary","journal","manual-refresh","metadata","mixed-provenance","multi-tab","multi-window","native-close","native-move","native-open","nested","nested-window","opener","outliner-close","paired-echo","partial-close","partial-snapshot","post-recovery","race","real-user","reconciliation","relocation","reparenting","restart","restore","restored","restored-scope","runtime-order","runtimeMetadata","saved","scope-routing","scope-shape","session","shape-fact","snapshot-confidence","stale-event","stale-query","subagent","tombstone","transaction-boundary","undo-redo","updated-event","window-scope","window-state"],"firstTraceId":"dh-restore-delayed-focus-refresh","lastTraceId":"yh-rung2-two-mixed-windows-close-one-partial","runs":800,"processRuns":40,"batchSize":20,"batchFailures":0,"completedCorpus":true,"failures":0,"duplicateFailures":0,"newFindings":0} -->
