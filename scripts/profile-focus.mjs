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
    scenario: "command-event-echo"
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
    } else if (arg === "--scenario" && next) {
      options.scenario = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 2) {
    throw new Error("--tabs must be an integer >= 2");
  }
  if (!["first", "middle", "last"].includes(options.target)) {
    throw new Error("--target must be first, middle, or last");
  }
  if (options.target === "first") {
    throw new Error("--target first is already active; choose middle or last");
  }
  if (!["command-event-echo"].includes(options.scenario)) {
    throw new Error("--scenario must be command-event-echo");
  }

  return options;
}

function targetTabId(tabCount, target) {
  if (target === "middle") {
    return Math.ceil(tabCount / 2);
  }
  return tabCount;
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
      url: `https://focus.example/${index + 1}`,
      title: `Tab ${index + 1}`
    })),
    saves: 0,
    broadcasts: 0,
    saveStringifyMs: 0,
    broadcastStringifyMs: 0,
    projectionMs: 0,
    bytes: 0,
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
        measureRuntimeJson(runtime, "broadcast", message);
        if (message?.type === "stateUpdated" && message.state) {
          const projection = measure(() => buildVisibleTreeProjection(message.state, ""));
          runtime.projectionMs += projection.ms;
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
      update: async (windowId, updateInfo = {}) => {
        if (updateInfo.focused) {
          runtime.windows = runtime.windows.map((windowInfo) => ({
            ...windowInfo,
            focused: windowInfo.id === windowId
          }));
          runtime.events.windowFocusChanged.dispatch(windowId);
        }
        return { ...runtime.windows.find((windowInfo) => windowInfo.id === windowId) };
      },
      remove: async () => undefined,
      create: async () => {
        throw new Error("not implemented");
      },
      onFocusChanged: events.windowFocusChanged,
      onRemoved: events.windowRemoved
    },
    tabs: {
      query: async () => runtime.tabs.map((tab) => ({ ...tab })),
      update: async (tabId, updateProperties = {}) => {
        const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) {
          throw new Error(`Missing tab ${tabId}`);
        }
        const previous = runtime.tabs.find((candidate) => candidate.windowId === tab.windowId && candidate.active);
        if (updateProperties.active) {
          runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId
            ? { ...candidate, active: candidate.id === tabId }
            : { ...candidate });
          runtime.events.tabActivated.dispatch({
            tabId,
            windowId: tab.windowId,
            ...(previous ? { previousTabId: previous.id } : {})
          });
        }
        return { ...runtime.tabs.find((candidate) => candidate.id === tabId) };
      },
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

async function flushAll(runtime) {
  await Promise.all([
    runtime.events.windowFocusChanged.flush(),
    runtime.events.tabActivated.flush(),
    runtime.events.tabUpdated.flush(),
    runtime.events.tabCreated.flush(),
    runtime.events.sessionChanged.flush()
  ]);
}

async function profile(options) {
  const runtime = makeRuntime(options.tabs);
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  const init = await measureAsync(() => controller.ensureState());
  const tabId = targetTabId(options.tabs, options.target);
  const nodeId = `tab:${tabId}`;

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.saveStringifyMs = 0;
  runtime.broadcastStringifyMs = 0;
  runtime.projectionMs = 0;
  runtime.bytes = 0;

  const command = await measureAsync(() => controller.handleMessage({ type: "focusNode", nodeId }));
  const eventEcho = await measureAsync(() => flushAll(runtime));
  const current = await controller.handleMessage({ type: "getState" });

  return {
    scenario: options.scenario,
    tabs: options.tabs,
    target: options.target,
    nodeId,
    initMs: Math.round(init.ms),
    commandMs: Math.round(command.ms),
    eventEchoMs: Math.round(eventEcho.ms),
    totalMeasuredMs: Math.round(command.ms + eventEcho.ms),
    saveStringifyMs: Math.round(runtime.saveStringifyMs),
    broadcastStringifyMs: Math.round(runtime.broadcastStringifyMs),
    projectionMs: Math.round(runtime.projectionMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    ack: command.value,
    activeNodeStatus: current.nodes[nodeId]?.active,
    previousActiveNodeStatus: current.nodes["tab:1"]?.active,
    nodes: Object.keys(current.nodes).length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
