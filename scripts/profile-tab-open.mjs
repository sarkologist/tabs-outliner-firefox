import { performance } from "node:perf_hooks";

import { createBackgroundController } from "../dist/background/controller.js";

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

  async emit(...args) {
    this.dispatch(...args);
    await this.flush();
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
    updates: 5,
    scenario: "open-tab-storm"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tabs" && next) {
      options.tabs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--updates" && next) {
      options.updates = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--scenario" && next) {
      options.scenario = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 1) {
    throw new Error("--tabs must be a positive integer");
  }
  if (!Number.isFinite(options.updates) || options.updates < 0) {
    throw new Error("--updates must be a non-negative integer");
  }
  if (!["open-tab-storm", "noop-update", "metadata-noop-update"].includes(options.scenario)) {
    throw new Error("--scenario must be open-tab-storm, noop-update, or metadata-noop-update");
  }

  return options;
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
      url: `https://large.example/${index + 1}`,
      title: `Tab ${index + 1}`
    })),
    saves: 0,
    broadcasts: 0,
    stringifyMs: 0,
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
        measureJson(runtime, message);
        runtime.broadcasts += 1;
      }
    },
    storage: {
      local: {
        get: async (key) => typeof key === "string" ? { [key]: undefined } : {},
        set: async (items) => {
          measureJson(runtime, items);
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

function measureJson(runtime, value) {
  const start = performance.now();
  const json = JSON.stringify(value);
  runtime.stringifyMs += performance.now() - start;
  runtime.bytes += json.length;
}

async function runOpenTabStorm(runtime, updateCount) {
  const newTabId = runtime.tabs.length + 1;
  const newTab = {
    id: newTabId,
    windowId: 10,
    index: runtime.tabs.length,
    active: true,
    url: "about:newtab",
    title: "New Tab"
  };
  runtime.tabs = runtime.tabs.map((tab) => ({ ...tab, active: false }));
  runtime.tabs.push(newTab);

  runtime.events.tabCreated.dispatch({ ...newTab });
  for (let index = 0; index < updateCount; index += 1) {
    const updated = {
      ...newTab,
      title: `New Tab ${index + 1}`,
      url: index === updateCount - 1 ? "https://opened.example/" : newTab.url
    };
    runtime.tabs[runtime.tabs.length - 1] = updated;
    runtime.events.tabUpdated.dispatch(updated.id, { title: updated.title, url: updated.url }, { ...updated });
  }
  runtime.events.tabActivated.dispatch({ tabId: newTabId, windowId: 10, previousTabId: 1 });

  await flushAll(runtime);
}

async function runNoopUpdate(runtime) {
  const tab = { ...runtime.tabs[0] };
  runtime.events.tabUpdated.dispatch(tab.id, {}, tab);
  await flushAll(runtime);
}

async function runMetadataNoopUpdate(runtime) {
  const tab = { ...runtime.tabs[0] };
  runtime.events.tabUpdated.dispatch(tab.id, {
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl
  }, tab);
  await flushAll(runtime);
}

async function flushAll(runtime) {
  await Promise.all([
    runtime.events.tabCreated.flush(),
    runtime.events.tabUpdated.flush(),
    runtime.events.tabActivated.flush(),
    runtime.events.windowFocusChanged.flush(),
    runtime.events.sessionChanged.flush()
  ]);
}

async function profile({ tabs, updates, scenario }) {
  const runtime = makeRuntime(tabs);
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  const initStart = performance.now();
  await controller.ensureState();
  const initMs = performance.now() - initStart;

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.stringifyMs = 0;
  runtime.bytes = 0;

  const start = performance.now();
  if (scenario === "open-tab-storm") {
    await runOpenTabStorm(runtime, updates);
  } else if (scenario === "metadata-noop-update") {
    await runMetadataNoopUpdate(runtime);
  } else {
    await runNoopUpdate(runtime);
  }
  const totalMs = performance.now() - start;
  const state = await controller.handleMessage({ type: "getState" });
  const saveFlushStart = performance.now();
  await controller.flushPendingSaves();
  const saveFlushMs = performance.now() - saveFlushStart;

  return {
    scenario,
    tabs,
    updates: scenario === "open-tab-storm" ? updates : 0,
    initMs: Math.round(initMs),
    totalMs: Math.round(totalMs),
    saveFlushMs: Math.round(saveFlushMs),
    totalWithSaveFlushMs: Math.round(totalMs + saveFlushMs),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    stringifyMs: Math.round(runtime.stringifyMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    nodes: Object.keys(state.nodes).length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
