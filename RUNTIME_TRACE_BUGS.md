# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic runtime trace hunts.
The current adversarial hunt mode runs explicit domain trace artifacts that Codex/humans can inspect and mutate with runtime/model knowledge. Historical adaptive seed-frontier and seed-sweep findings are preserved as evidence and alternate repros, not as the current adversarial selection mechanism.
The hunt intentionally documents findings without fixing them.

Run the hunt with:

```sh
pnpm trace-hunt:runtime
```

Default hunt bounds:

- Iteration limit: 5 minutes
- Stop condition: 3 consecutive iterations with no new distinct findings
- Trace selection: explicit domain trace corpus; mutate domain actions between iterations instead of perturbing seeds
- Test target: `src/background/controller.test.ts`
- Test name: `adversarial runtime domain traces`
- Trace filter: `RUNTIME_TRACE_HUNT_TRACE_IDS=rt-active-race,rt-stale-updated-after-move`

## Last Domain Run

- Completed: 2026-05-23T10:58:52.252Z
- Strategy: explicit domain trace corpus, with agent-in-loop trace edits between hunt iterations
- Trace ids: `rt-active-race`, `rt-created-race-after-window-close`, `rt-stale-created-after-move`, `rt-stale-updated-after-move`, `rt-native-close-after-relocation`, `rt-restore-delete-delayed-stale-event`
- Distinct domain findings recorded: 2
- Stop condition reached: iterations 2, 3, and 4 found no new distinct signatures
- Duplicate failures during final clean streak: 6

## Finding Index

- Current domain trace adversary: RT-009, RT-010
- Previous adaptive seed-frontier run: RT-001 through RT-008
- Recovered pre-adaptive seed sweep: SS-001 through SS-006

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
- Status: documented, not fixed.

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
