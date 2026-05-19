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
  if (![
    "open-tab-storm",
    "new-window-storm",
    "runtime-refresh-backlog",
    "startup-initial-snapshot",
    "startup-warm-initial-snapshot",
    "startup-stored-unchanged",
    "noop-update",
    "metadata-noop-update"
  ].includes(options.scenario)) {
    throw new Error(
      "--scenario must be open-tab-storm, new-window-storm, runtime-refresh-backlog, startup-initial-snapshot, startup-warm-initial-snapshot, startup-stored-unchanged, noop-update, or metadata-noop-update"
    );
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
    storage: new Map(),
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
        measureJson(runtime, message);
        runtime.broadcasts += 1;
      }
    },
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === "string") {
            return { [key]: runtime.storage.get(key) };
          }
          return Object.fromEntries(runtime.storage);
        },
        set: async (items) => {
          measureJson(runtime, items);
          for (const [key, value] of Object.entries(items)) {
            runtime.storage.set(key, value);
          }
          runtime.saves += 1;
        },
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            runtime.storage.delete(key);
          }
        },
        onChanged: new FakeEvent()
      },
      onChanged: new FakeEvent()
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: async (windowId) => {
        const windowInfo = runtime.windows.find((candidate) => candidate.id === windowId);
        if (!windowInfo) {
          throw new Error(`Missing window: ${windowId}`);
        }
        return { ...windowInfo };
      },
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function waitForMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function measureJson(runtime, value) {
  const start = performance.now();
  const json = JSON.stringify(value);
  runtime.stringifyMs += performance.now() - start;
  runtime.bytes += json.length;
}

function makeProfileAdapter({ focusStarted, releaseFocus } = {}) {
  return {
    focusTab: async () => {
      focusStarted?.resolve();
      await releaseFocus?.promise;
    },
    closeTab: async () => undefined,
    closeTabs: async () => undefined,
    closeWindow: async () => undefined,
    restoreSession: async () => ({}),
    createTab: async () => {
      throw new Error("not implemented");
    },
    createWindow: async () => {
      throw new Error("not implemented");
    },
    moveTabs: async () => undefined
  };
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

async function runNewWindowStorm(runtime, updateCount) {
  const newWindowId = Math.max(...runtime.windows.map((windowInfo) => windowInfo.id)) + 1;
  const newTabId = runtime.tabs.length + 1;
  const newTab = {
    id: newTabId,
    windowId: newWindowId,
    index: 0,
    active: true,
    url: "about:newtab",
    title: "New Tab"
  };
  runtime.windows = runtime.windows
    .map((windowInfo) => ({ ...windowInfo, focused: false }))
    .concat({ id: newWindowId, focused: true, incognito: false });
  runtime.tabs = runtime.tabs.map((tab) => ({ ...tab, active: false })).concat(newTab);

  runtime.events.tabCreated.dispatch({ ...newTab });
  for (let index = 0; index < updateCount; index += 1) {
    const updated = {
      ...newTab,
      title: `New Window Tab ${index + 1}`,
      url: index === updateCount - 1 ? "https://new-window.example/" : newTab.url
    };
    runtime.tabs[runtime.tabs.length - 1] = updated;
    runtime.events.tabUpdated.dispatch(updated.id, { title: updated.title, url: updated.url }, { ...updated });
  }
  runtime.events.tabActivated.dispatch({ tabId: newTabId, windowId: newWindowId, previousTabId: 1 });

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

async function runRuntimeRefreshBacklog(runtime, controller, focusStarted, releaseFocus) {
  const focusPromise = controller.handleMessage({ type: "focusNode", nodeId: "tab:1" });
  await focusStarted.promise;
  const targetTab = runtime.tabs[1] ?? runtime.tabs[0];
  runtime.tabs = runtime.tabs.map((tab) => tab.windowId === targetTab.windowId
    ? { ...tab, active: tab.id === targetTab.id }
    : { ...tab });
  runtime.events.tabActivated.dispatch({ tabId: targetTab.id, windowId: targetTab.windowId, previousTabId: 1 });
  await waitForMacrotask();

  const commandStart = performance.now();
  const renamePromise = controller.handleMessage({
    type: "renameGroup",
    nodeId: "window:10",
    title: "Backlog command"
  });
  releaseFocus.resolve();
  await renamePromise;
  const commandWaitMs = performance.now() - commandStart;
  await focusPromise;
  await runtime.events.tabActivated.flush();

  const trace = await controller.handleMessage({ type: "getPerformanceTrace" });
  const mutationStarts = Array.isArray(trace?.entries)
    ? trace.entries.filter((entry) => entry.name === "background.mutation.start")
    : [];
  const runtimeRefreshJobs = mutationStarts.filter((entry) => entry.detail?.reason === "refreshFromRuntime").length;
  const lowRuntimeRefreshJobs = mutationStarts.filter((entry) =>
    entry.detail?.reason === "refreshFromRuntime" && entry.detail?.priority === "low"
  ).length;

  return {
    commandWaitMs: Math.round(commandWaitMs),
    runtimeRefreshJobs,
    lowRuntimeRefreshJobs
  };
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
  if (scenario === "startup-stored-unchanged") {
    return profileStartupStoredUnchanged({ tabs });
  }
  if (scenario === "startup-initial-snapshot") {
    return profileStartupInitialSnapshot({ tabs });
  }
  if (scenario === "startup-warm-initial-snapshot") {
    return profileStartupWarmInitialSnapshot({ tabs });
  }

  const runtime = makeRuntime(tabs);
  const focusStarted = deferred();
  const releaseFocus = deferred();
  const controller = createBackgroundController({
    api: runtime.api,
    now: () => 1000,
    ...(scenario === "runtime-refresh-backlog"
      ? { adapter: makeProfileAdapter({ focusStarted, releaseFocus }) }
      : {})
  });
  const initStart = performance.now();
  await controller.ensureState();
  const initMs = performance.now() - initStart;

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.stringifyMs = 0;
  runtime.bytes = 0;

  if (scenario === "runtime-refresh-backlog") {
    await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: true });
    await controller.handleMessage({ type: "clearPerformanceTrace" });
  }

  const start = performance.now();
  let scenarioMetrics = {};
  if (scenario === "open-tab-storm") {
    await runOpenTabStorm(runtime, updates);
  } else if (scenario === "new-window-storm") {
    await runNewWindowStorm(runtime, updates);
  } else if (scenario === "runtime-refresh-backlog") {
    scenarioMetrics = await runRuntimeRefreshBacklog(runtime, controller, focusStarted, releaseFocus);
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
    updates: scenario === "open-tab-storm" || scenario === "new-window-storm" ? updates : 0,
    initMs: Math.round(initMs),
    totalMs: Math.round(totalMs),
    saveFlushMs: Math.round(saveFlushMs),
    totalWithSaveFlushMs: Math.round(totalMs + saveFlushMs),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    stringifyMs: Math.round(runtime.stringifyMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    nodes: Object.keys(state.nodes).length,
    ...scenarioMetrics
  };
}

async function profileStartupStoredUnchanged({ tabs }) {
  const runtime = makeRuntime(tabs);
  const firstController = createBackgroundController({ api: runtime.api, now: () => 1000 });
  await firstController.ensureState();
  await firstController.flushPendingSaves();

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.stringifyMs = 0;
  runtime.bytes = 0;

  const secondController = createBackgroundController({ api: runtime.api, now: () => 2000 });
  const start = performance.now();
  const state = await secondController.ensureState();
  const totalMs = performance.now() - start;
  const saveFlushStart = performance.now();
  await secondController.flushPendingSaves();
  const saveFlushMs = performance.now() - saveFlushStart;

  return {
    scenario: "startup-stored-unchanged",
    tabs,
    updates: 0,
    initMs: Math.round(totalMs),
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

async function profileStartupInitialSnapshot({ tabs }) {
  const runtime = makeRuntime(tabs);
  const firstController = createBackgroundController({ api: runtime.api, now: () => 1000 });
  await firstController.ensureState();
  await firstController.flushPendingSaves();

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.stringifyMs = 0;
  runtime.bytes = 0;

  const secondController = createBackgroundController({ api: runtime.api, now: () => 2000 });
  const initialStart = performance.now();
  const snapshot = await secondController.handleMessage({ type: "getInitialTreeSnapshot" });
  const initialMs = performance.now() - initialStart;
  const fullStart = performance.now();
  const state = await secondController.handleMessage({ type: "getState" });
  const hydrateMs = performance.now() - fullStart;

  return {
    scenario: "startup-initial-snapshot",
    tabs,
    updates: 0,
    initMs: Math.round(initialMs),
    totalMs: Math.round(initialMs),
    hydrateMs: Math.round(hydrateMs),
    totalWithHydrationMs: Math.round(initialMs + hydrateMs),
    saveFlushMs: 0,
    totalWithSaveFlushMs: Math.round(initialMs),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    stringifyMs: Math.round(runtime.stringifyMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    snapshotRows: Array.isArray(snapshot?.projection?.rows) ? snapshot.projection.rows.length : 0,
    snapshotNodes: snapshot?.state?.nodes ? Object.keys(snapshot.state.nodes).length : 0,
    hydrating: Boolean(snapshot?.hydrating),
    nodes: Object.keys(state.nodes).length
  };
}

async function profileStartupWarmInitialSnapshot({ tabs }) {
  const runtime = makeRuntime(tabs);
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  await controller.ensureState();

  runtime.saves = 0;
  runtime.broadcasts = 0;
  runtime.stringifyMs = 0;
  runtime.bytes = 0;

  const start = performance.now();
  const snapshot = await controller.handleMessage({ type: "getInitialTreeSnapshot" });
  const totalMs = performance.now() - start;
  const snapshotJsonStart = performance.now();
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotStringifyMs = performance.now() - snapshotJsonStart;

  return {
    scenario: "startup-warm-initial-snapshot",
    tabs,
    updates: 0,
    initMs: Math.round(totalMs),
    totalMs: Math.round(totalMs),
    saveFlushMs: 0,
    totalWithSaveFlushMs: Math.round(totalMs),
    saves: runtime.saves,
    broadcasts: runtime.broadcasts,
    stringifyMs: Math.round(runtime.stringifyMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    snapshotStringifyMs: Math.round(snapshotStringifyMs),
    snapshotMb: Math.round(snapshotJson.length / 1024 / 1024),
    snapshotRows: Array.isArray(snapshot?.projection?.rows) ? snapshot.projection.rows.length : 0,
    snapshotNodes: snapshot?.state?.nodes ? Object.keys(snapshot.state.nodes).length : 0,
    snapshotTotalRows: snapshot?.projection?.totalRowCount ?? 0,
    hydrating: Boolean(snapshot?.hydrating)
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
