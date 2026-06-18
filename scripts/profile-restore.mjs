import { performance } from "node:perf_hooks";

import { createBackgroundController } from "../dist/background/controller.js";
import { runCommand } from "../dist/background/commands.js";
import { analyzeRestoreScope, planRestore } from "../dist/model/outline.js";
import { outlineStateV4Snapshot } from "../dist/background/storage-v4.js";
import { buildVisibleTreeProjection } from "../dist/sidebar/visible-tree.js";
import {
  PROFILE_EVENT_NAMES,
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
    scenario: "single-closed-tab",
    target: "last",
    echo: "final"
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
    } else if (arg === "--target" && next) {
      options.target = next;
      index += 1;
    } else if (arg === "--echo" && next) {
      options.echo = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 1) {
    throw new Error("--tabs must be a positive integer");
  }
  if (!["single-closed-tab", "controller-event-echo"].includes(options.scenario)) {
    throw new Error("--scenario must be single-closed-tab or controller-event-echo");
  }
  if (!["first", "middle", "last"].includes(options.target)) {
    throw new Error("--target must be first, middle, or last");
  }
  if (!["final", "transient", "transient-separated"].includes(options.echo)) {
    throw new Error("--echo must be final, transient, or transient-separated");
  }

  return options;
}

function targetTabId(tabCount, target) {
  if (target === "first") {
    return 1;
  }
  if (target === "middle") {
    return Math.ceil(tabCount / 2);
  }
  return tabCount;
}

function largeClosedTabState(tabCount, target) {
  const root = {
    id: "window:10",
    kind: "window",
    status: "live",
    childIds: [],
    title: "Group",
    active: true,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: { windowId: 10 }
  };
  const state = {
    version: 1,
    rootIds: [root.id],
    nodes: {
      [root.id]: root
    }
  };
  const activeTarget = targetTabId(tabCount, target);

  for (let index = 1; index <= tabCount; index += 1) {
    const id = `tab:${index}`;
    root.childIds.push(id);
    state.nodes[id] = {
      id,
      kind: "tab",
      status: "closed",
      parentId: root.id,
      childIds: [],
      title: `Saved ${index}`,
      url: `https://restore.example/${index}`,
      collapsed: false,
      createdAt: 1000,
      updatedAt: 1000,
      closedAt: 2000 + index,
      restore: {
        url: `https://restore.example/${index}`,
        title: `Saved ${index}`
      }
    };
  }

  return {
    state,
    nodeId: `tab:${activeTarget}`
  };
}

function fakeAdapter() {
  const calls = {
    createTab: 0,
    createWindow: 0,
    restoreSession: 0
  };
  return {
    calls,
    adapter: {
      focusTab: async () => undefined,
      closeTab: async () => undefined,
      closeTabs: async () => undefined,
      closeWindow: async () => undefined,
      restoreSession: async () => {
        calls.restoreSession += 1;
        return {};
      },
      createTab: async ({ url, windowId = 10 }) => {
        calls.createTab += 1;
        return {
          id: 100_000 + calls.createTab,
          windowId,
          index: 0,
          active: false,
          url,
          title: url
        };
      },
      createWindow: async ({ url }) => {
        calls.createWindow += 1;
        const urls = Array.isArray(url) ? url : url ? [url] : [];
        return {
          id: 200_000 + calls.createWindow,
          focused: true,
          incognito: false,
          tabs: urls.map((tabUrl, index) => ({
            id: 300_000 + index,
            windowId: 200_000 + calls.createWindow,
            index,
            active: index === 0,
            url: tabUrl,
            title: tabUrl
          }))
        };
      },
      moveTabs: async () => undefined
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

function measureJson(value) {
  return measure(() => JSON.stringify(value));
}

function measureRuntimeJson(runtime, bucket, value) {
  const measured = measureJson(value);
  runtime[`${bucket}StringifyMs`] += measured.ms;
  runtime.bytes += measured.value.length;
}

function restorePatchCandidateNodeIds(state, nodeId) {
  const nodeIds = new Set();
  for (const plan of planRestore(state, nodeId)) {
    nodeIds.add(plan.nodeId);
    if (plan.windowNodeId) {
      nodeIds.add(plan.windowNodeId);
    }
  }
  return [...nodeIds];
}

function nodeStateUpdateForNodeIds(previous, next, nodeIds) {
  let closedCountDelta = 0;
  const updatedNodes = [];
  for (const nodeId of nodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId];
    if (!previousNode || !node || previousNode === node) {
      continue;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

function applyNodeStateUpdate(runtime, update) {
  if (!runtime.sidebarState || !runtime.sidebarProjection) {
    return;
  }

  const updatedNodes = new Map(update.updatedNodes.map((node) => [node.id, node]));
  for (const node of update.updatedNodes) {
    runtime.sidebarState.nodes[node.id] = node;
  }
  runtime.sidebarProjection.closedCount = Math.max(
    0,
    runtime.sidebarProjection.closedCount + update.closedCountDelta
  );

  for (const row of runtime.sidebarProjection.rows) {
    const node = updatedNodes.get(row.nodeId);
    if (!node) {
      continue;
    }
    row.childCount = node.childIds.length;
    row.visibleChildCount = node.childIds.length;
    row.expanded = !node.collapsed;
  }
}

function makeControllerRuntime(initialState) {
  const { events, eventCounts } = createProfileEvents();
  const runtime = {
    windows: [{ id: 10, focused: true, incognito: false }],
    tabs: [],
    storage: new Map(
      Object.entries(
        JSON.parse(
          JSON.stringify(
            outlineStateV4Snapshot(initialState, { epoch: 1, journalSeqIncluded: 0 }).setItems
          )
        )
      )
    ),
    restoreEcho: "final",
    ...createStorageMetrics(),
    ...createBroadcastMetrics(),
    broadcastStringifyMs: 0,
    projectionMs: 0,
    nodePatchMs: 0,
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
        }
        recordProfileBroadcast(runtime, message);
      }
    },
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === "string") {
            return { [key]: runtime.storage.get(key) };
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((entry) => [entry, runtime.storage.get(entry)]));
          }
          return Object.fromEntries(runtime.storage);
        },
        set: async (items) => {
          recordProfileStorageSet(runtime, items, measure);
          for (const [key, value] of Object.entries(items)) {
            runtime.storage.set(key, value);
          }
        },
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            runtime.storage.delete(key);
          }
        },
        onChanged: createPassiveEvent()
      },
      onChanged: createPassiveEvent()
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => runtime.windows.map((windowInfo) => ({ ...windowInfo })),
      update: async () => ({}),
      remove: async () => undefined,
      create: async () => {
        throw new Error("not implemented");
      },
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
      move: async () => [],
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

function fakeControllerAdapter(runtime) {
  const calls = {
    createTab: 0,
    createWindow: 0,
    restoreSession: 0
  };
  return {
    calls,
    adapter: {
      focusTab: async () => undefined,
      closeTab: async () => undefined,
      closeTabs: async () => undefined,
      closeWindow: async () => undefined,
      restoreSession: async () => {
        calls.restoreSession += 1;
        return {};
      },
      createTab: async ({ url, windowId = 10, active = false }) => {
        calls.createTab += 1;
        if (active) {
          runtime.tabs = runtime.tabs.map((tab) => ({ ...tab, active: false }));
        }
        const tab = {
          id: 100_000 + calls.createTab,
          windowId,
          index: runtime.tabs.length,
          active,
          url,
          title: url
        };
        runtime.tabs.push(tab);
        if (runtime.restoreEcho === "transient" || runtime.restoreEcho === "transient-separated") {
          runtime.events.tabCreated.dispatch({
            ...tab,
            url: "about:blank",
            title: "New Tab"
          });
          if (runtime.restoreEcho === "transient") {
            runtime.events.tabUpdated.dispatch(
              tab.id,
              {
                url: tab.url,
                title: tab.title
              },
              { ...tab }
            );
          }
        } else {
          runtime.events.tabCreated.dispatch({ ...tab });
        }
        return { ...tab };
      },
      createWindow: async ({ url }) => {
        calls.createWindow += 1;
        const windowId = 200_000 + calls.createWindow;
        const urls = Array.isArray(url) ? url : url ? [url] : [];
        const windowInfo = { id: windowId, focused: true, incognito: false };
        const tabs = urls.map((tabUrl, index) => ({
          id: 300_000 + index,
          windowId,
          index,
          active: index === 0,
          url: tabUrl,
          title: tabUrl
        }));
        runtime.windows.push(windowInfo);
        runtime.tabs.push(...tabs);
        for (const tab of tabs) {
          runtime.events.tabCreated.dispatch({ ...tab });
        }
        return { ...windowInfo, tabs: tabs.map((tab) => ({ ...tab })) };
      },
      moveTabs: async () => undefined
    }
  };
}

async function profileCommand(options) {
  const { state, nodeId } = largeClosedTabState(options.tabs, options.target);
  const { adapter, calls } = fakeAdapter();

  const sidebarScope = measure(() => analyzeRestoreScope(state, nodeId));
  const command = await measureAsync(() =>
    runCommand(state, adapter, { type: "restoreNode", nodeId })
  );
  const saved = measureJson({ outlineState: command.value.state });
  const candidateNodeIds = restorePatchCandidateNodeIds(state, nodeId);
  const nodeUpdate = measure(() =>
    nodeStateUpdateForNodeIds(state, command.value.state, candidateNodeIds)
  );
  const broadcast = measureJson(nodeUpdate.value);
  const sidebarState = state;
  const sidebarProjection = buildVisibleTreeProjection(sidebarState, "");
  const patch = measure(() =>
    applyNodeStateUpdate({ sidebarState, sidebarProjection }, nodeUpdate.value)
  );

  return {
    scenario: options.scenario,
    tabs: options.tabs,
    target: options.target,
    nodeId,
    sidebarScopeMs: Math.round(sidebarScope.ms),
    commandMs: Math.round(command.ms),
    nodePatchBuildMs: Math.round(nodeUpdate.ms),
    saveStringifyMs: Math.round(saved.ms),
    broadcastStringifyMs: Math.round(broadcast.ms),
    projectionMs: 0,
    nodePatchMs: Math.round(patch.ms),
    totalMeasuredMs: Math.round(
      sidebarScope.ms + command.ms + nodeUpdate.ms + saved.ms + broadcast.ms + patch.ms
    ),
    mbStringified: Math.round((saved.value.length + broadcast.value.length) / 1024 / 1024),
    changed: command.value.changed,
    createTabCalls: calls.createTab,
    createWindowCalls: calls.createWindow,
    restoreSessionCalls: calls.restoreSession,
    eventCounts: Object.fromEntries(PROFILE_EVENT_NAMES.map((name) => [name, 0])),
    eventCount: 0,
    nodes: Object.keys(command.value.state.nodes).length,
    rows: sidebarProjection.rows.length
  };
}

async function profileControllerEventEcho(options) {
  const { state, nodeId } = largeClosedTabState(options.tabs, options.target);
  const runtime = makeControllerRuntime(state);
  runtime.restoreEcho = options.echo;
  const { adapter, calls } = fakeControllerAdapter(runtime);
  const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
  const init = await measureAsync(() => controller.ensureState());
  runtime.sidebarState = await controller.handleMessage({ type: "getState" });
  runtime.sidebarProjection = buildVisibleTreeProjection(runtime.sidebarState, "");
  await settleProfileBackgroundWork();

  resetStorageMetrics(runtime);
  resetBroadcastMetrics(runtime);
  runtime.broadcastStringifyMs = 0;
  runtime.projectionMs = 0;
  runtime.nodePatchMs = 0;
  runtime.operationStart = performance.now();
  runtime.firstBroadcastMs = undefined;
  resetEventCounts(runtime.eventCounts);

  const command = await measureAsync(() =>
    controller.handleMessage({ type: "restoreNode", nodeId })
  );
  const eventEcho = await measureAsync(() => flushProfileEvents(runtime.events));
  if (options.echo === "transient-separated") {
    const restoredTab = runtime.tabs.at(-1);
    if (restoredTab) {
      runtime.events.tabUpdated.dispatch(
        restoredTab.id,
        {
          url: restoredTab.url,
          title: restoredTab.title
        },
        { ...restoredTab }
      );
    }
  }
  const updateEcho = await measureAsync(() => flushProfileEvents(runtime.events));
  const current = await controller.handleMessage({ type: "getState" });
  const saveFlush = await measureAsync(() => controller.flushPendingSaves());

  return {
    scenario: options.scenario,
    tabs: options.tabs,
    target: options.target,
    echo: options.echo,
    nodeId,
    initMs: Math.round(init.ms),
    commandMs: Math.round(command.ms),
    eventEchoMs: Math.round(eventEcho.ms),
    updateEchoMs: Math.round(updateEcho.ms),
    totalMeasuredMs: Math.round(command.ms + eventEcho.ms + updateEcho.ms),
    saveFlushMs: Math.round(saveFlush.ms),
    totalWithSaveFlushMs: Math.round(command.ms + eventEcho.ms + updateEcho.ms + saveFlush.ms),
    firstBroadcastMs: Math.round(runtime.firstBroadcastMs ?? 0),
    ...storageMetricsResult(runtime),
    broadcastStringifyMs: Math.round(runtime.broadcastStringifyMs),
    projectionMs: Math.round(runtime.projectionMs),
    nodePatchMs: Math.round(runtime.nodePatchMs),
    ...broadcastMetricsResult(runtime),
    ack: command.value,
    createTabCalls: calls.createTab,
    createWindowCalls: calls.createWindow,
    restoreSessionCalls: calls.restoreSession,
    eventCounts: eventCountsSnapshot(runtime.eventCounts),
    eventCount: eventCountsTotal(runtime.eventCounts),
    nodes: Object.keys(current.nodes).length
  };
}

async function profile(options) {
  if (options.scenario === "controller-event-echo") {
    return profileControllerEventEcho(options);
  }
  return profileCommand(options);
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
