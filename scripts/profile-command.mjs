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
    "flatten-window",
    "import-small",
    "refresh-noop"
  ].includes(options.scenario)) {
    throw new Error(
      "--scenario must be rename-window, toggle-window, move-leaf, flatten-window, import-small, or refresh-noop"
    );
  }

  return options;
}

function makeRuntime(tabCount, scenario) {
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
      ...(scenario === "flatten-window" && index > 0 ? { openerTabId: 1 } : {}),
      url: `https://command.example/${index + 1}`,
      title: `Tab ${index + 1}`
    })),
    saves: 0,
    broadcasts: 0,
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
    commands: {
      onCommand: new FakeEvent(),
      getAll: async () => [],
      update: async () => undefined,
      reset: async () => undefined
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
        onChanged: new FakeEvent()
      },
      onChanged: new FakeEvent()
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

async function flushAll(runtime) {
  await Promise.all([
    runtime.events.tabCreated.flush(),
    runtime.events.tabUpdated.flush(),
    runtime.events.tabActivated.flush(),
    runtime.events.tabRemoved.flush(),
    runtime.events.windowFocusChanged.flush(),
    runtime.events.windowRemoved.flush(),
    runtime.events.sessionChanged.flush()
  ]);
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
  runtime.saveStringifyMs = 0;
  runtime.broadcastStringifyMs = 0;
  runtime.projectionMs = 0;
  runtime.nodePatchMs = 0;
  runtime.treePatchMs = 0;
  runtime.bytes = 0;
  runtime.operationStart = performance.now();
  runtime.firstBroadcastMs = undefined;

  const command = await measureAsync(() => controller.handleMessage(commandForScenario(options.scenario, options.tabs)));
  const eventEcho = await measureAsync(() => flushAll(runtime));
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
    ack: command.value,
    nodes: Object.keys(current.nodes).length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
