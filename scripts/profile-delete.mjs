import { performance } from "node:perf_hooks";

import { createBackgroundController } from "../dist/background/controller.js";
import { buildVisibleTreeProjection } from "../dist/sidebar/visible-tree.js";

class FakeEvent {
  listeners = [];
  pending = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  dispatch(...args) {
    for (const listener of this.listeners) {
      try {
        const result = listener(...args);
        if (result && typeof result.then === "function") {
          this.pending.push(result);
        }
      } catch (error) {
        this.pending.push(Promise.reject(error));
      }
    }
  }

  async flush() {
    while (this.pending.length > 0) {
      const pending = this.pending;
      this.pending = [];
      const results = await Promise.allSettled(pending);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) {
        throw rejected.reason;
      }
    }
  }
}

function parseArgs(argv) {
  const options = {
    tabs: 50_000,
    target: "last",
    count: 1
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tabs" && next) {
      options.tabs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--target" && next) {
      options.target = next;
      index += 1;
    } else if (arg === "--count" && next) {
      options.count = Number.parseInt(next, 10);
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 2) {
    throw new Error("--tabs must be an integer >= 2");
  }
  if (!Number.isFinite(options.count) || options.count < 1 || options.count >= options.tabs) {
    throw new Error("--count must be an integer between 1 and tabs - 1");
  }
  if (!["first", "middle", "last"].includes(options.target)) {
    throw new Error("--target must be first, middle, or last");
  }

  return options;
}

function targetTabIds(tabCount, target, count) {
  if (target === "first") {
    return Array.from({ length: count }, (_value, index) => index + 1);
  }
  if (target === "middle") {
    const start = Math.max(1, Math.ceil(tabCount / 2) - Math.floor(count / 2));
    return Array.from({ length: count }, (_value, index) => start + index);
  }
  return Array.from({ length: count }, (_value, index) => tabCount - index);
}

function makeRuntime(tabCount) {
  const events = {
    tabCreated: new FakeEvent(),
    tabUpdated: new FakeEvent(),
    tabActivated: new FakeEvent(),
    tabRemoved: new FakeEvent(),
    windowRemoved: new FakeEvent(),
    windowFocusChanged: new FakeEvent(),
    sessionChanged: new FakeEvent()
  };
  const runtime = {
    windows: [{ id: 10, focused: true, incognito: false }],
    tabs: Array.from({ length: tabCount }, (_value, index) => ({
      id: index + 1,
      windowId: 10,
      index,
      active: index === 0,
      url: `https://delete.example/${index + 1}`,
      title: `Tab ${index + 1}`
    })),
    saves: 0,
    broadcasts: 0,
    saveStringifyMs: 0,
    broadcastStringifyMs: 0,
    projectionMs: 0,
    treePatchMs: 0,
    bytes: 0,
    operationStart: 0,
    firstBroadcastMs: undefined,
    sidebarState: undefined,
    sidebarProjection: undefined,
    events,
    api: undefined
  };

  runtime.api = {
    action: {
      onClicked: new FakeEvent()
    },
    sidebarAction: {
      open: async () => undefined,
      toggle: async () => undefined
    },
    runtime: {
      onInstalled: new FakeEvent(),
      onStartup: new FakeEvent(),
      onMessage: new FakeEvent(),
      sendMessage: async (message) => {
        runtime.firstBroadcastMs ??= performance.now() - runtime.operationStart;
        measureRuntimeJson(runtime, "broadcast", message);
        if (message?.type === "stateUpdated" && message.state) {
          runtime.sidebarState = message.state;
          const projection = measure(() => buildVisibleTreeProjection(message.state, ""));
          runtime.sidebarProjection = projection.value;
          runtime.projectionMs += projection.ms;
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
        onChanged: new FakeEvent()
      }
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
      remove: async (tabIds) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tabId of ids) {
          closeRuntimeTab(runtime, tabId);
        }
      },
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

function closeRuntimeTab(runtime, tabId) {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }

  runtime.tabs = runtime.tabs
    .filter((candidate) => candidate.id !== tabId)
    .map((candidate) => candidate.windowId === tab.windowId && candidate.index > tab.index
      ? { ...candidate, index: candidate.index - 1 }
      : candidate);
  runtime.events.tabRemoved.dispatch(tab.id, {
    windowId: tab.windowId,
    isWindowClosing: false
  });
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

function applyTreeStructureUpdate(runtime, update) {
  if (!runtime.sidebarState || !runtime.sidebarProjection) {
    return;
  }

  const deletedNodeIds = new Set(update.deletedNodeIds);
  for (const nodeId of deletedNodeIds) {
    delete runtime.sidebarState.nodes[nodeId];
  }
  for (const node of update.updatedNodes) {
    runtime.sidebarState.nodes[node.id] = node;
  }
  runtime.sidebarState.rootIds = [...update.rootIds];

  const updatedNodes = new Map(update.updatedNodes.map((node) => [node.id, node]));
  runtime.sidebarProjection.rows = runtime.sidebarProjection.rows.filter((row) => !deletedNodeIds.has(row.nodeId));
  for (let index = 0; index < runtime.sidebarProjection.rows.length; index += 1) {
    const row = runtime.sidebarProjection.rows[index];
    row.index = index;
  }
  runtime.sidebarProjection.visibleNodeIds = runtime.sidebarProjection.rows.map((row) => row.nodeId);
  runtime.sidebarProjection.visibleNodeIdSet = new Set(runtime.sidebarProjection.visibleNodeIds);
  runtime.sidebarProjection.nodeCount = Math.max(0, runtime.sidebarProjection.nodeCount - update.deletedNodeIds.length);
  runtime.sidebarProjection.closedCount = Math.max(0, runtime.sidebarProjection.closedCount - update.deletedClosedCount);

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

async function flushAll(runtime) {
  await Promise.all([
    runtime.events.tabRemoved.flush(),
    runtime.events.sessionChanged.flush(),
    runtime.events.tabUpdated.flush(),
    runtime.events.tabActivated.flush(),
    runtime.events.windowFocusChanged.flush()
  ]);
}

async function profile(options) {
  const runtime = makeRuntime(options.tabs);
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  const init = await measureAsync(() => controller.ensureState());
  runtime.sidebarState = await controller.handleMessage({ type: "getState" });
  runtime.sidebarProjection = buildVisibleTreeProjection(runtime.sidebarState, "");
  const nodeIds = targetTabIds(options.tabs, options.target, options.count).map((tabId) => `tab:${tabId}`);

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.saveStringifyMs = 0;
  runtime.broadcastStringifyMs = 0;
  runtime.projectionMs = 0;
  runtime.treePatchMs = 0;
  runtime.bytes = 0;
  runtime.operationStart = performance.now();
  runtime.firstBroadcastMs = undefined;

  let commandMs = 0;
  let eventEchoMs = 0;
  let lastAck;
  for (const nodeId of nodeIds) {
    const command = await measureAsync(() => controller.handleMessage({ type: "deleteNode", nodeId }));
    const eventEcho = await measureAsync(() => flushAll(runtime));
    commandMs += command.ms;
    eventEchoMs += eventEcho.ms;
    lastAck = command.value;
  }
  const current = await controller.handleMessage({ type: "getState" });

  return {
    scenario: "command-event-echo",
    tabs: options.tabs,
    target: options.target,
    count: nodeIds.length,
    firstNodeId: nodeIds[0],
    lastNodeId: nodeIds.at(-1),
    initMs: Math.round(init.ms),
    commandMs: Math.round(commandMs),
    eventEchoMs: Math.round(eventEchoMs),
    totalMeasuredMs: Math.round(commandMs + eventEchoMs),
    averageMeasuredMs: Math.round((commandMs + eventEchoMs) / nodeIds.length),
    firstBroadcastMs: Math.round(runtime.firstBroadcastMs ?? 0),
    saveStringifyMs: Math.round(runtime.saveStringifyMs),
    broadcastStringifyMs: Math.round(runtime.broadcastStringifyMs),
    projectionMs: Math.round(runtime.projectionMs),
    treePatchMs: Math.round(runtime.treePatchMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    ack: lastAck,
    deletedNodePresent: nodeIds.some((nodeId) => Boolean(current.nodes[nodeId])),
    nodes: Object.keys(current.nodes).length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
