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
    order: "tabRemovedThenSessionChanged"
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
    } else if (arg === "--order" && next) {
      options.order = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 2) {
    throw new Error("--tabs must be an integer >= 2");
  }
  if (!["first", "middle", "last"].includes(options.target)) {
    throw new Error("--target must be first, middle, or last");
  }
  if (!["tabRemovedThenSessionChanged", "sessionChangedThenTabRemoved"].includes(options.order)) {
    throw new Error("--order must be tabRemovedThenSessionChanged or sessionChangedThenTabRemoved");
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

function makeRuntime(tabCount, order) {
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
      url: `https://close.example/${index + 1}`,
      title: `Tab ${index + 1}`
    })),
    recentlyClosed: undefined,
    saves: 0,
    broadcasts: 0,
    saveStringifyMs: 0,
    broadcastStringifyMs: 0,
    projectionMs: 0,
    bytes: 0,
    tabsQueryMs: 0,
    windowsGetAllMs: 0,
    recentClosedCalls: 0,
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
      getAll: async () => {
        const measured = measure(() => runtime.windows.map((windowInfo) => ({ ...windowInfo })));
        runtime.windowsGetAllMs += measured.ms;
        return measured.value;
      },
      update: async () => ({}),
      remove: async () => undefined,
      create: async () => {
        throw new Error("not implemented");
      },
      onFocusChanged: events.windowFocusChanged,
      onRemoved: events.windowRemoved
    },
    tabs: {
      query: async () => {
        const measured = measure(() => runtime.tabs.map((tab) => ({ ...tab })));
        runtime.tabsQueryMs += measured.ms;
        return measured.value;
      },
      update: async () => ({}),
      remove: async (tabIds) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tabId of ids) {
          closeRuntimeTab(runtime, tabId, order);
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
      getRecentlyClosed: async () => {
        runtime.recentClosedCalls += 1;
        return runtime.recentlyClosed ? [runtime.recentlyClosed] : [];
      },
      restore: async () => ({}),
      onChanged: events.sessionChanged
    }
  };

  return runtime;
}

function closeRuntimeTab(runtime, tabId, order) {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }

  runtime.tabs = runtime.tabs
    .filter((candidate) => candidate.id !== tabId)
    .map((candidate) => candidate.windowId === tab.windowId && candidate.index > tab.index
      ? { ...candidate, index: candidate.index - 1 }
      : candidate);
  runtime.recentlyClosed = {
    tab: {
      sessionId: `session-tab-${tab.id}`
    }
  };

  const tabRemoved = () => runtime.events.tabRemoved.dispatch(tab.id, {
    windowId: tab.windowId,
    isWindowClosing: false
  });
  const sessionChanged = () => runtime.events.sessionChanged.dispatch();

  if (order === "sessionChangedThenTabRemoved") {
    sessionChanged();
    tabRemoved();
  } else {
    tabRemoved();
    sessionChanged();
  }
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
    runtime.events.tabRemoved.flush(),
    runtime.events.sessionChanged.flush(),
    runtime.events.tabUpdated.flush(),
    runtime.events.tabActivated.flush(),
    runtime.events.windowFocusChanged.flush()
  ]);
}

async function profile(options) {
  const runtime = makeRuntime(options.tabs, options.order);
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
  runtime.tabsQueryMs = 0;
  runtime.windowsGetAllMs = 0;
  runtime.recentClosedCalls = 0;

  const command = await measureAsync(() => controller.handleMessage({ type: "closeNode", nodeId }));
  const eventEcho = await measureAsync(() => flushAll(runtime));
  const current = await controller.handleMessage({ type: "getState" });

  return {
    scenario: "command-event-echo",
    order: options.order,
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
    tabsQueryMs: Math.round(runtime.tabsQueryMs),
    windowsGetAllMs: Math.round(runtime.windowsGetAllMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    recentClosedCalls: runtime.recentClosedCalls,
    ack: command.value,
    closedNodeStatus: current.nodes[nodeId]?.status,
    nodes: Object.keys(current.nodes).length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
