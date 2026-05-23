# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic runtime trace hunts.
The current adversarial hunt mode defaults to lower-anchoring discovery traces guided by `RUNTIME_TRACE_HUNT_GUIDE.md`; known RT/SS-derived traces are preserved as regression coverage and explicit replay evidence, not as the default mutation prompt.
The hunt intentionally documents findings before fixes; fix passes update statuses while preserving the original repros.

Run the hunt with:

```sh
pnpm trace-hunt:runtime
```

Default hunt bounds:

- Corpus run cap: 5 minutes
- Agent stop condition: 3 full 5-minute discovery mutation blocks with no new distinct findings
- Trace selection: default profile is `discovery`; use `RUNTIME_TRACE_HUNT_PROFILE=regression|all` for known repro replay, or `RUNTIME_TRACE_HUNT_TRACE_IDS=...` for explicit trace replay
- Corpus semantics: execute the selected explicit domain trace corpus once, recording every distinct failure; mutate discovery domain actions between runs instead of perturbing seeds
- Test target: `src/background/controller.test.ts`
- Test name: `adversarial runtime domain traces`
- Trace filter: `RUNTIME_TRACE_HUNT_TRACE_IDS=rt-active-race,rt-stale-updated-after-move`

## Last Domain Run

- Completed: 2026-05-23T15:10:04Z
- Strategy: lower-priming discovery profile, with agent-in-loop trace edits guided by `RUNTIME_TRACE_HUNT_GUIDE.md`
- Trace ids: current discovery corpus in `src/background/controller.test.ts` and `scripts/hunt-runtime-traces.mjs`
- Distinct discovery findings recorded: 4
- New findings in lower-priming discovery hunt: RT-022 through RT-025
- Stop condition reached: yes; after RT-025, 3 full discovery mutation blocks found no new distinct signatures
- Duplicate failures during final clean mutation blocks: 16
- Regression safety replay: 65 known regression traces, 0 failures

## Finding Index

- Open lower-priming discovery findings: RT-022 through RT-025
- Fixed domain trace adversary findings: RT-009 through RT-021
- Previous adaptive seed-frontier run: RT-001 through RT-008
- Recovered pre-adaptive seed sweep: SS-001 through SS-006

## Fix Analysis

- Active-state relocation race: RT-001, RT-002, RT-009, RT-010, SS-001, and SS-002 were fixed by applying browser-returned command-created window tab data to relocated outline tabs instead of preserving stale pre-command `active` flags.
- Stale old-window relocation echoes: RT-003 through RT-008 and SS-003 through SS-006 were fixed by keeping old-window stale echo protection after fresh current-window events; protection now ends only when the tab/node disappears or a later command updates the tracked destination.
- Empty source/destination windows after command relocation: RT-011, RT-019, RT-020, and RT-021 were fixed by making the fake browser remove windows emptied by tab moves/closes, and by closing/promoting source outline windows when a command relocation moves all owned live tabs into a command-created runtime window.
- Native close ownership: RT-012, RT-013, RT-014, and RT-016 were fixed by treating `windows.onRemoved` as authoritative browser-window close evidence; the outline now preserves the closed window subtree instead of deleting the single removed tab first.
- Delete rejection recovery: RT-015, RT-019, RT-020, and RT-021 were fixed by continuing through every resource in a captured close plan, then recovering model deletion when the runtime resources are already gone despite an adapter rejection.
- Removed relocated-tab resurrection: RT-017 and RT-018 were fixed by limiting session-only missing-window cleanup to command-relocated tabs and by keeping removed/deleted tombstones in stale relocation fallback paths.
- Verification: all listed generated seed repros and promoted domain trace repros pass as of the principled runtime trace fix pass.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
