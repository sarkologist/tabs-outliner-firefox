import { performance } from "node:perf_hooks";

import { createBackgroundController } from "../dist/background/controller.js";
import {
  applyCrossParentLeafMoveTreeStructurePatchToProjection,
  applyDeleteTreeStructurePatchToProjection,
  applyInsertTreeStructurePatchToProjection,
  applySameParentReorderTreeStructurePatchToProjection,
  buildVisibleTreeProjection
} from "../dist/sidebar/visible-tree.js";
import {
  createAlarmApi,
  createPassiveEvent,
  createProfileEvents,
  eventCountsSnapshot,
  eventCountsTotal,
  flushProfileEvents,
  resetEventCounts,
  settleProfileBackgroundWork
} from "./profile-harness.mjs";
import {
  broadcastMetricsResult,
  createBroadcastMetrics,
  createStorageMetrics,
  recordProfileBroadcast,
  recordProfileStorageSet,
  resetBroadcastMetrics,
  resetStorageMetrics,
  storageMetricsResult
} from "./profile-storage-metrics.mjs";

function parseArgs(argv) {
  const options = {
    tabs: 50_000,
    scenario: "rename-window"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tabs" && next) {
      options.tabs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--scenario" && next) {
      options.scenario = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 2) {
    throw new Error("--tabs must be an integer >= 2");
  }
  if (![
    "rename-window",
    "toggle-window",
    "move-leaf",
    "group-live-leaf",
    "move-top-level-live-leaf",
    "command-relocation-echo",
    "command-existing-window-relocation-echo",
    "structural-save-pressure",
    "flatten-window",
    "import-small",
    "import-large",
    "compaction-after-burst",
    "refresh-noop"
  ].includes(options.scenario)) {
    throw new Error(
      "--scenario must be rename-window, toggle-window, move-leaf, group-live-leaf, move-top-level-live-leaf, command-relocation-echo, command-existing-window-relocation-echo, structural-save-pressure, flatten-window, import-small, import-large, compaction-after-burst, or refresh-noop"
    );
  }

  return options;
}

function makeRuntime(tabCount, scenario) {
  const { events, eventCounts } = createProfileEvents();
  const runtime = {
    windows: [{ id: 10, focused: true, incognito: false }],
    tabs: Array.from({ length: tabCount }, (_value, index) => ({
      id: index + 1,
      windowId: 10,
      index,
      active: index === 0,
      ...(scenario === "flatten-window" && index > 0 ? { openerTabId: 1 } : {}),
      url: `https://command.example/${index + 1}`,
      title: `Tab ${index + 1}`
    })),
    ...createStorageMetrics(),
    ...createBroadcastMetrics(),
    createdWindows: 0,
    createWindowMs: 0,
    moveCalls: 0,
    movedTabCount: 0,
    maxMoveBatch: 0,
    moveTabsMs: 0,
    broadcastStringifyMs: 0,
    projectionMs: 0,
    nodePatchMs: 0,
    treePatchMs: 0,
    operationStart: 0,
    firstBroadcastMs: undefined,
    sidebarState: undefined,
    sidebarProjection: undefined,
    eventCounts,
    events,
    primaryCommandAcked: false,
    stateSaveDelayMs: 0,
    stateSaveStartedBeforeAck: false,
    delayedStateSaveStartedAt: undefined,
    delayedStateSaveCount: 0,
    existingCommandWindowNodeId: undefined,
    api: undefined
  };

  runtime.api = {
    action: {
      onClicked: createPassiveEvent()
    },
    sidebarAction: {
      open: async () => undefined,
      toggle: async () => undefined
    },
    commands: {
      onCommand: createPassiveEvent(),
      getAll: async () => [],
      update: async () => undefined,
      reset: async () => undefined
    },
    alarms: createAlarmApi(),
    runtime: {
      onInstalled: createPassiveEvent(),
      onStartup: createPassiveEvent(),
      onMessage: createPassiveEvent(),
      sendMessage: async (message) => {
        runtime.firstBroadcastMs ??= performance.now() - runtime.operationStart;
        measureRuntimeJson(runtime, "broadcast", message);
        if (message?.type === "stateUpdated" && message.state) {
          runtime.sidebarState = message.state;
          const projection = measure(() => buildVisibleTreeProjection(message.state, ""));
          runtime.sidebarProjection = projection.value;
          runtime.projectionMs += projection.ms;
        } else if (message?.type === "nodeStateUpdated") {
          const patch = measure(() => applyNodeStateUpdate(runtime, message));
          runtime.nodePatchMs += patch.ms;
        } else if (message?.type === "treeStructureUpdated") {
          const patch = measure(() => applyTreeStructureUpdate(runtime, message));
          runtime.treePatchMs += patch.ms;
        }
        recordProfileBroadcast(runtime, message);
      }
    },
    storage: {
      local: {
        get: async (key) => typeof key === "string" ? { [key]: undefined } : {},
        set: async (items) => {
          if (runtime.stateSaveDelayMs > 0 && isStateSnapshotSave(items)) {
            runtime.delayedStateSaveCount += 1;
            runtime.stateSaveStartedBeforeAck ||= !runtime.primaryCommandAcked;
            runtime.delayedStateSaveStartedAt ??= performance.now();
            await sleep(runtime.stateSaveDelayMs);
          }
          recordProfileStorageSet(runtime, items, measure);
        },
        remove: async () => undefined,
        onChanged: createPassiveEvent()
      },
      onChanged: createPassiveEvent()
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => runtime.windows.map((windowInfo) => ({ ...windowInfo })),
      update: async () => ({}),
      remove: async () => undefined,
      create: async (createData = {}) => createWindow(runtime, createData),
      onFocusChanged: events.windowFocusChanged,
      onRemoved: events.windowRemoved
    },
    tabs: {
      query: async () => runtime.tabs.map((tab) => ({ ...tab })),
      update: async () => ({}),
      remove: async () => undefined,
      create: async () => {
        throw new Error("not implemented");
      },
      move: async (tabIds, moveProperties) => moveTabs(runtime, tabIds, moveProperties, { count: true }),
      onCreated: events.tabCreated,
      onUpdated: events.tabUpdated,
      onActivated: events.tabActivated,
      onDetached: events.tabDetached,
      onAttached: events.tabAttached,
      onMoved: events.tabMoved,
      onRemoved: events.tabRemoved
    },
    sessions: {
      getRecentlyClosed: async () => [],
      restore: async () => ({}),
      onChanged: events.sessionChanged
    }
  };

  return runtime;
}

function createWindow(runtime, createData = {}) {
  const start = performance.now();
  try {
    const windowId = Math.max(0, ...runtime.windows.map((windowInfo) => windowInfo.id)) + 1;
    runtime.createdWindows += 1;
    const focused = createData.focused ?? true;
    runtime.windows = runtime.windows
      .map((windowInfo) => ({ ...windowInfo, focused: false }))
      .concat({ id: windowId, focused, incognito: false });

    if (typeof createData.tabId === "number") {
      const tabs = moveTabs(runtime, [createData.tabId], { windowId, index: 0 }, { count: false });
      if (focused) {
        runtime.events.windowFocusChanged.dispatch(windowId);
      }
      return {
        id: windowId,
        focused,
        incognito: false,
        tabs
      };
    }

    const urls = Array.isArray(createData.url) ? createData.url : createData.url ? [createData.url] : [];
    const firstTabId = Math.max(0, ...runtime.tabs.map((tab) => tab.id)) + 1;
    const tabs = urls.map((url, index) => ({
      id: firstTabId + index,
      windowId,
      index,
      active: index === 0,
      url,
      title: url
    }));
    runtime.tabs = [...runtime.tabs, ...tabs];
    if (focused) {
      runtime.events.windowFocusChanged.dispatch(windowId);
    }
    for (const tab of tabs) {
      runtime.events.tabCreated.dispatch({ ...tab });
    }
    const activeTab = tabs.find((tab) => tab.active);
    if (activeTab) {
      runtime.events.tabActivated.dispatch({ tabId: activeTab.id, windowId });
    }

    return {
      id: windowId,
      focused,
      incognito: false,
      tabs: tabs.map((tab) => ({ ...tab }))
    };
  } finally {
    runtime.createWindowMs += performance.now() - start;
  }
}

function moveTabs(runtime, tabIds, moveProperties, options = {}) {
  const start = performance.now();
  try {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    if (options.count) {
      runtime.moveCalls += 1;
      runtime.movedTabCount += ids.length;
      runtime.maxMoveBatch = Math.max(runtime.maxMoveBatch, ids.length);
    }

    const tabById = new Map(runtime.tabs.map((tab) => [tab.id, tab]));
    const movingIds = new Set(ids);
    const moving = ids.flatMap((tabId) => {
      const tab = tabById.get(tabId);
      return tab ? [{ ...tab }] : [];
    });
    if (moving.length === 0) {
      return [];
    }

    const targetWindowId = moveProperties.windowId ?? moving[0].windowId;
    const affectedWindowIds = new Set([targetWindowId, ...moving.map((tab) => tab.windowId)]);
    const remaining = runtime.tabs.filter((tab) => !movingIds.has(tab.id));
    const targetTabs = remaining
      .filter((tab) => tab.windowId === targetWindowId)
      .sort((left, right) => left.index - right.index)
      .map((tab) => ({ ...tab }));
    const boundedIndex = Math.max(0, Math.min(moveProperties.index, targetTabs.length));
    targetTabs.splice(boundedIndex, 0, ...moving.map((tab) => ({ ...tab, windowId: targetWindowId })));

    const previousActiveByWindowId = new Map(
      runtime.tabs.filter((tab) => tab.active).map((tab) => [tab.windowId, tab.id])
    );
    runtime.tabs = [
      ...remaining.filter((tab) => tab.windowId !== targetWindowId).map((tab) => ({ ...tab })),
      ...targetTabs.map((tab, index) => ({
        ...tab,
        index
      }))
    ];
    for (const windowId of affectedWindowIds) {
      let index = 0;
      runtime.tabs = runtime.tabs.map((tab) => tab.windowId === windowId
        ? {
            ...tab,
            index: index++
          }
        : tab);
    }

    const movedById = new Map(runtime.tabs.map((tab) => [tab.id, tab]));
    const moved = ids.flatMap((tabId) => {
      const tab = movedById.get(tabId);
      return tab ? [{ ...tab }] : [];
    });
    if (options.dispatch !== false) {
      for (const tab of moved) {
        runtime.events.tabUpdated.dispatch(tab.id, {
          index: tab.index,
          windowId: tab.windowId
        }, { ...tab });
        if (tab.active) {
          runtime.events.tabActivated.dispatch({
            tabId: tab.id,
            windowId: tab.windowId,
            ...(previousActiveByWindowId.has(tab.windowId)
              ? { previousTabId: previousActiveByWindowId.get(tab.windowId) }
              : {})
          });
        }
      }
    }
    return moved;
  } finally {
    runtime.moveTabsMs += performance.now() - start;
  }
}

async function prepareScenario(controller, runtime, scenario) {
  if (scenario !== "command-existing-window-relocation-echo") {
    return;
  }

  await controller.handleMessage({
    type: "moveNode",
    nodeId: "tab:1",
    index: 0
  });
  const state = await controller.handleMessage({ type: "getState" });
  const destinationWindowNodeId = state.nodes["tab:1"]?.parentId;
  if (!destinationWindowNodeId) {
    throw new Error("Failed to prepare existing command relocation destination");
  }
  runtime.existingCommandWindowNodeId = destinationWindowNodeId;
}

function commandForScenario(scenario, tabCount, runtime) {
  if (scenario === "rename-window") {
    return { type: "renameGroup", nodeId: "window:10", title: "Profiled Group" };
  }
  if (scenario === "toggle-window") {
    return { type: "toggleCollapsed", nodeId: "window:10" };
  }
  if (scenario === "move-leaf") {
    return { type: "moveNode", nodeId: `tab:${tabCount}`, parentId: "window:10", index: 0 };
  }
  if (scenario === "group-live-leaf") {
    return { type: "wrapNodeInGroup", nodeId: "tab:1" };
  }
  if (scenario === "move-top-level-live-leaf") {
    return { type: "moveSubtreeToTopLevel", nodeId: `tab:${tabCount}` };
  }
  if (scenario === "command-relocation-echo") {
    return { type: "moveSubtreeToTopLevel", nodeId: `tab:${tabCount}` };
  }
  if (scenario === "command-existing-window-relocation-echo") {
    if (!runtime.existingCommandWindowNodeId) {
      throw new Error("command-existing-window-relocation-echo requires a prepared destination window");
    }
    return { type: "moveNode", nodeId: `tab:${tabCount}`, parentId: runtime.existingCommandWindowNodeId, index: 1 };
  }
  if (scenario === "structural-save-pressure") {
    return { type: "moveSubtreeToTopLevel", nodeId: `tab:${tabCount}` };
  }
  if (scenario === "flatten-window") {
    return { type: "flattenSubtree", nodeId: "window:10" };
  }
  if (scenario === "import-small") {
    return importTreeCommand([
      {
        kind: "tab",
        title: "Imported Tab",
        url: "https://imported.example/",
        children: []
      }
    ]);
  }
  if (scenario === "import-large") {
    return importTreeCommand([
      {
        kind: "window",
        title: "Imported Large Window",
        children: Array.from({ length: tabCount }, (_value, index) => ({
          kind: "tab",
          title: `Imported Tab ${index + 1}`,
          url: `https://imported.example/${index + 1}`,
          children: []
        }))
      }
    ]);
  }
  return { type: "refresh" };
}

function importTreeCommand(roots) {
  return {
    type: "importTree",
    tree: {
      schema: "tabs-outliner-tree",
      version: 1,
      exportedAt: "2026-05-16T12:00:00.000Z",
      roots
    }
  };
}

function measure(fn) {
  const start = performance.now();
  const value = fn();
  return {
    value,
    ms: performance.now() - start
  };
}

async function measureAsync(fn) {
  const start = performance.now();
  const value = await fn();
  return {
    value,
    ms: performance.now() - start
  };
}

function measureRuntimeJson(runtime, bucket, value) {
  const measured = measure(() => JSON.stringify(value));
  runtime[`${bucket}StringifyMs`] += measured.ms;
  runtime.bytes += measured.value.length;
}

function applyNodeStateUpdate(runtime, update) {
  if (!runtime.sidebarState || update.updatedNodes.length === 0) {
    return;
  }

  let collapsedChanged = false;
  for (const node of update.updatedNodes) {
    const previous = runtime.sidebarState.nodes[node.id];
    collapsedChanged ||= previous?.collapsed !== node.collapsed;
    runtime.sidebarState.nodes[node.id] = node;
  }

  if (!runtime.sidebarProjection || collapsedChanged) {
    const projection = measure(() => buildVisibleTreeProjection(runtime.sidebarState, ""));
    runtime.sidebarProjection = projection.value;
    runtime.projectionMs += projection.ms;
  }
}

function applyTreeStructureUpdate(runtime, update) {
  if (!runtime.sidebarState) {
    return;
  }

  for (const nodeId of update.deletedNodeIds) {
    delete runtime.sidebarState.nodes[nodeId];
  }
  for (const node of update.updatedNodes) {
    runtime.sidebarState.nodes[node.id] = node;
  }
  runtime.sidebarState.rootIds = [...update.rootIds];

  if (!runtime.sidebarProjection || !applyProjectionTreeStructureUpdate(runtime, update)) {
    const projection = measure(() => buildVisibleTreeProjection(runtime.sidebarState, ""));
    runtime.sidebarProjection = projection.value;
    runtime.projectionMs += projection.ms;
  }
}

function applyProjectionTreeStructureUpdate(runtime, update) {
  if (update.deletedNodeIds.length === 0) {
    return applySameParentReorderTreeStructurePatchToProjection(runtime.sidebarState, runtime.sidebarProjection, update) ||
      applyCrossParentLeafMoveTreeStructurePatchToProjection(runtime.sidebarState, runtime.sidebarProjection, update) ||
      applyInsertTreeStructurePatchToProjection(runtime.sidebarState, runtime.sidebarProjection, update);
  }

  return applyDeleteTreeStructurePatchToProjection(runtime.sidebarState, runtime.sidebarProjection, update);
}

async function profile(options) {
  const runtime = makeRuntime(options.tabs, options.scenario);
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  const init = await measureAsync(() => controller.ensureState());
  await prepareScenario(controller, runtime, options.scenario);
  await controller.flushPendingSaves();
  runtime.sidebarState = await controller.handleMessage({ type: "getState" });
  runtime.sidebarProjection = buildVisibleTreeProjection(runtime.sidebarState, "");
  await settleProfileBackgroundWork();
  const traceBackground = process.env.PROFILE_BACKGROUND_TRACE === "1";
  if (traceBackground) {
    await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: true });
    await controller.handleMessage({ type: "clearPerformanceTrace" });
  }

  resetStorageMetrics(runtime);
  resetBroadcastMetrics(runtime);
  runtime.createdWindows = 0;
  runtime.createWindowMs = 0;
  runtime.moveCalls = 0;
  runtime.movedTabCount = 0;
  runtime.maxMoveBatch = 0;
  runtime.moveTabsMs = 0;
  resetEventCounts(runtime.eventCounts);
  runtime.broadcastStringifyMs = 0;
  runtime.projectionMs = 0;
  runtime.nodePatchMs = 0;
  runtime.treePatchMs = 0;
  runtime.operationStart = performance.now();
  runtime.firstBroadcastMs = undefined;
  runtime.primaryCommandAcked = false;
  runtime.stateSaveStartedBeforeAck = false;
  runtime.delayedStateSaveStartedAt = undefined;
  runtime.delayedStateSaveCount = 0;
  runtime.stateSaveDelayMs = options.scenario === "structural-save-pressure" ? 250 : 0;

  const command = await measureAsync(() => options.scenario === "compaction-after-burst"
    ? runCompactionBurst(controller, options.tabs)
    : controller.handleMessage(commandForScenario(options.scenario, options.tabs, runtime)));
  runtime.primaryCommandAcked = true;
  dispatchScenarioNativeEchoes(runtime, options.scenario, options.tabs);
  const eventEcho = await measureAsync(() => flushProfileEvents(runtime.events));
  const followUp = options.scenario === "structural-save-pressure"
    ? await measureFollowUpDuringDeferredSave(controller, runtime)
    : undefined;
  const current = await controller.handleMessage({ type: "getState" });
  const saveFlush = followUp?.saveFlush ?? await measureAsync(() => controller.flushPendingSaves());
  const trace = traceBackground
    ? await controller.handleMessage({ type: "getPerformanceTrace" })
    : undefined;

  return {
    scenario: options.scenario,
    tabs: options.tabs,
    initMs: Math.round(init.ms),
    commandMs: Math.round(command.ms),
    eventEchoMs: Math.round(eventEcho.ms),
    totalMeasuredMs: Math.round(command.ms + eventEcho.ms),
    saveFlushMs: Math.round(saveFlush.ms),
    totalWithSaveFlushMs: Math.round(command.ms + eventEcho.ms + saveFlush.ms),
    ...(followUp ? {
      followUpCommandMs: Math.round(followUp.command.ms),
      stateSaveStartedBeforeAck: runtime.stateSaveStartedBeforeAck,
      delayedStateSaveCount: runtime.delayedStateSaveCount
    } : {}),
    firstBroadcastMs: Math.round(runtime.firstBroadcastMs ?? 0),
    ...storageMetricsResult(runtime),
    broadcastStringifyMs: Math.round(runtime.broadcastStringifyMs),
    projectionMs: Math.round(runtime.projectionMs),
    nodePatchMs: Math.round(runtime.nodePatchMs),
    treePatchMs: Math.round(runtime.treePatchMs),
    ...broadcastMetricsResult(runtime),
    createdWindows: runtime.createdWindows,
    createWindowMs: Math.round(runtime.createWindowMs),
    moveCalls: runtime.moveCalls,
    movedTabCount: runtime.movedTabCount,
    maxMoveBatch: runtime.maxMoveBatch,
    moveTabsMs: Math.round(runtime.moveTabsMs),
    eventCounts: eventCountsSnapshot(runtime.eventCounts),
    eventCount: eventCountsTotal(runtime.eventCounts),
    ...(traceBackground ? { trace: summarizeTrace(trace), traceSummary: summarizeTraceSummary(trace) } : {}),
    ack: command.value,
    nodes: Object.keys(current.nodes).length,
    rootShape: summarizeRootShape(current)
  };
}

// 20 mixed small mutations, each journaled before its ack, followed by one explicit flush:
// the burst must coalesce into ONE compaction (saves=1) with bounded journal writes.
async function runCompactionBurst(controller, tabCount) {
  let lastAck;
  for (let index = 0; index < 20; index += 1) {
    const kind = index % 3;
    const message = kind === 0
      ? { type: "renameGroup", nodeId: "window:10", title: `Burst ${index}` }
      : kind === 1
        ? { type: "toggleCollapsed", nodeId: "window:10" }
        : { type: "moveNode", nodeId: `tab:${(index % tabCount) + 1}`, parentId: "window:10", index: 0 };
    lastAck = await controller.handleMessage(message);
  }
  return lastAck;
}

async function measureFollowUpDuringDeferredSave(controller, runtime) {
  const saveFlushPromise = measureAsync(() => controller.flushPendingSaves());
  await waitForDelayedStateSaveStart(runtime);
  const command = await measureAsync(() => controller.handleMessage({ type: "focusNode", nodeId: "tab:1" }));
  const saveFlush = await saveFlushPromise;
  return { command, saveFlush };
}

async function waitForDelayedStateSaveStart(runtime) {
  const deadline = performance.now() + 1000;
  while (runtime.delayedStateSaveStartedAt === undefined && performance.now() < deadline) {
    await sleep(0);
  }
}

function isStateSnapshotSave(items) {
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return false;
  }
  return Object.keys(items).some((key) =>
    key === "outlineState:v3:manifest" || key.startsWith("outline:v4:manifest:")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));

function dispatchScenarioNativeEchoes(runtime, scenario, tabCount) {
  if (scenario !== "command-relocation-echo" && scenario !== "command-existing-window-relocation-echo") {
    return;
  }

  const moved = runtime.tabs.find((tab) => tab.id === tabCount);
  if (!moved || moved.windowId === 10) {
    return;
  }

  runtime.events.tabDetached.dispatch(moved.id, {
    oldWindowId: 10,
    oldPosition: tabCount - 1
  });
  runtime.events.tabAttached.dispatch(moved.id, {
    newWindowId: moved.windowId,
    newPosition: moved.index
  });
  runtime.events.tabMoved.dispatch(moved.id, {
    windowId: moved.windowId,
    fromIndex: moved.index,
    toIndex: moved.index
  });
  if (scenario === "command-existing-window-relocation-echo") {
    runtime.events.tabUpdated.dispatch(moved.id, { title: moved.title }, { ...moved });
  }
}

function summarizeTrace(trace) {
  const entries = Array.isArray(trace?.entries) ? trace.entries : [];
  return entries
    .filter((entry) => typeof entry.durationMs === "number")
    .map((entry) => ({
      name: entry.name,
      durationMs: Math.round(entry.durationMs),
      detail: entry.detail
    }))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 20);
}

function summarizeTraceSummary(trace) {
  const entries = Array.isArray(trace?.entries) ? trace.entries : [];
  const measured = entries.filter((entry) => typeof entry.durationMs === "number");
  return {
    byName: Object.fromEntries(summarizeBy(measured, (entry) => entry.name).map((row) => [row.name, row])),
    runtimeMessageTypes: Object.fromEntries(
      summarizeBy(
        measured.filter((entry) => entry.name === "background.runtime.message"),
        (entry) => entry.detail?.type ?? "(unknown)"
      ).map((row) => [row.name, row])
    ),
    mutationRuns: Object.fromEntries(
      summarizeBy(
        measured.filter((entry) => entry.name === "background.mutation.run"),
        (entry) => [
          entry.detail?.reason ?? "",
          entry.detail?.command ?? "",
          entry.detail?.source ?? "",
          entry.detail?.priority ?? ""
        ].join("/")
      ).map((row) => [row.name, row])
    )
  };
}

function summarizeBy(entries, keyFn) {
  const byKey = new Map();
  for (const entry of entries) {
    const name = keyFn(entry);
    const row = byKey.get(name) ?? {
      name,
      count: 0,
      totalMs: 0,
      avgMs: 0,
      maxMs: 0
    };
    row.count += 1;
    row.totalMs += entry.durationMs;
    row.maxMs = Math.max(row.maxMs, entry.durationMs);
    byKey.set(name, row);
  }
  return [...byKey.values()]
    .map((row) => ({
      ...row,
      totalMs: Math.round(row.totalMs),
      avgMs: Math.round(row.totalMs / row.count),
      maxMs: Math.round(row.maxMs)
    }))
    .sort((left, right) => right.totalMs - left.totalMs);
}

function summarizeRootShape(state) {
  const rootIds = Array.isArray(state?.rootIds) ? state.rootIds : [];
  const roots = rootIds.map((nodeId) => state.nodes?.[nodeId]);
  return {
    rootCount: rootIds.length,
    missingRootCount: roots.filter((node) => !node).length,
    windowRootCount: roots.filter((node) => node?.kind === "window").length,
    liveWindowRootCount: roots.filter((node) => node?.kind === "window" && node.status === "live").length,
    tabRootCount: roots.filter((node) => node?.kind === "tab").length,
    groupRootCount: roots.filter((node) => node?.kind === "group").length,
    childCounts: roots.map((node) => node?.childIds?.length ?? 0)
  };
}
