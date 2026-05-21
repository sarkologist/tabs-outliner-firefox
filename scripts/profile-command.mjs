import { performance } from "node:perf_hooks";

import { createBackgroundController } from "../dist/background/controller.js";
import { buildVisibleTreeProjection } from "../dist/sidebar/visible-tree.js";
import {
  createAlarmApi,
  createPassiveEvent,
  createProfileEvents,
  eventCountsSnapshot,
  eventCountsTotal,
  flushProfileEvents,
  resetEventCounts
} from "./profile-harness.mjs";

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
    "flatten-window",
    "import-small",
    "refresh-noop"
  ].includes(options.scenario)) {
    throw new Error(
      "--scenario must be rename-window, toggle-window, move-leaf, group-live-leaf, flatten-window, import-small, or refresh-noop"
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
    saves: 0,
    broadcasts: 0,
    createdWindows: 0,
    moveCalls: 0,
    movedTabCount: 0,
    maxMoveBatch: 0,
    saveStringifyMs: 0,
    broadcastStringifyMs: 0,
    projectionMs: 0,
    nodePatchMs: 0,
    treePatchMs: 0,
    bytes: 0,
    operationStart: 0,
    firstBroadcastMs: undefined,
    sidebarState: undefined,
    sidebarProjection: undefined,
    eventCounts,
    events,
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
        runtime.broadcasts += 1;
      }
    },
    storage: {
      local: {
        get: async (key) => typeof key === "string" ? { [key]: undefined } : {},
        set: async (items) => {
          measureRuntimeJson(runtime, "save", items);
          runtime.saves += 1;
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
}

function moveTabs(runtime, tabIds, moveProperties, options = {}) {
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
}

function commandForScenario(scenario, tabCount) {
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
  if (scenario === "flatten-window") {
    return { type: "flattenSubtree", nodeId: "window:10" };
  }
  if (scenario === "import-small") {
    return {
      type: "importTree",
      tree: {
        schema: "tabs-outliner-tree",
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "tab",
            title: "Imported Tab",
            url: "https://imported.example/",
            children: []
          }
        ]
      }
    };
  }
  return { type: "refresh" };
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

  const projection = measure(() => buildVisibleTreeProjection(runtime.sidebarState, ""));
  runtime.sidebarProjection = projection.value;
  runtime.projectionMs += projection.ms;
}

async function profile(options) {
  const runtime = makeRuntime(options.tabs, options.scenario);
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  const init = await measureAsync(() => controller.ensureState());
  await controller.flushPendingSaves();
  runtime.sidebarState = await controller.handleMessage({ type: "getState" });
  runtime.sidebarProjection = buildVisibleTreeProjection(runtime.sidebarState, "");

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.createdWindows = 0;
  runtime.moveCalls = 0;
  runtime.movedTabCount = 0;
  runtime.maxMoveBatch = 0;
  resetEventCounts(runtime.eventCounts);
  runtime.saveStringifyMs = 0;
  runtime.broadcastStringifyMs = 0;
  runtime.projectionMs = 0;
  runtime.nodePatchMs = 0;
  runtime.treePatchMs = 0;
  runtime.bytes = 0;
  runtime.operationStart = performance.now();
  runtime.firstBroadcastMs = undefined;

  const command = await measureAsync(() => controller.handleMessage(commandForScenario(options.scenario, options.tabs)));
  const eventEcho = await measureAsync(() => flushProfileEvents(runtime.events));
  const current = await controller.handleMessage({ type: "getState" });
  const saveFlush = await measureAsync(() => controller.flushPendingSaves());

  return {
    scenario: options.scenario,
    tabs: options.tabs,
    initMs: Math.round(init.ms),
    commandMs: Math.round(command.ms),
    eventEchoMs: Math.round(eventEcho.ms),
    totalMeasuredMs: Math.round(command.ms + eventEcho.ms),
    saveFlushMs: Math.round(saveFlush.ms),
    totalWithSaveFlushMs: Math.round(command.ms + eventEcho.ms + saveFlush.ms),
    firstBroadcastMs: Math.round(runtime.firstBroadcastMs ?? 0),
    saveStringifyMs: Math.round(runtime.saveStringifyMs),
    broadcastStringifyMs: Math.round(runtime.broadcastStringifyMs),
    projectionMs: Math.round(runtime.projectionMs),
    nodePatchMs: Math.round(runtime.nodePatchMs),
    treePatchMs: Math.round(runtime.treePatchMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    createdWindows: runtime.createdWindows,
    moveCalls: runtime.moveCalls,
    movedTabCount: runtime.movedTabCount,
    maxMoveBatch: runtime.maxMoveBatch,
    eventCounts: eventCountsSnapshot(runtime.eventCounts),
    eventCount: eventCountsTotal(runtime.eventCounts),
    ack: command.value,
    nodes: Object.keys(current.nodes).length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
