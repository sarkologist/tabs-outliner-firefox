import { performance } from "node:perf_hooks";

import { runCommand } from "../dist/background/commands.js";
import { analyzeRestoreScope } from "../dist/model/outline.js";
import { buildVisibleTreeProjection } from "../dist/sidebar/visible-tree.js";

function parseArgs(argv) {
  const options = {
    tabs: 50_000,
    scenario: "single-closed-tab",
    target: "last"
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
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 1) {
    throw new Error("--tabs must be a positive integer");
  }
  if (!["single-closed-tab"].includes(options.scenario)) {
    throw new Error("--scenario must be single-closed-tab");
  }
  if (!["first", "middle", "last"].includes(options.target)) {
    throw new Error("--target must be first, middle, or last");
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

async function profile(options) {
  const { state, nodeId } = largeClosedTabState(options.tabs, options.target);
  const { adapter, calls } = fakeAdapter();

  const sidebarScope = measure(() => analyzeRestoreScope(state, nodeId));
  const command = await measureAsync(() => runCommand(state, adapter, { type: "restoreNode", nodeId }));
  const saved = measureJson({ outlineState: command.value.state });
  const broadcast = measureJson({ type: "stateUpdated", state: command.value.state });
  const projection = measure(() => buildVisibleTreeProjection(command.value.state, ""));

  return {
    scenario: options.scenario,
    tabs: options.tabs,
    target: options.target,
    nodeId,
    sidebarScopeMs: Math.round(sidebarScope.ms),
    commandMs: Math.round(command.ms),
    saveStringifyMs: Math.round(saved.ms),
    broadcastStringifyMs: Math.round(broadcast.ms),
    projectionMs: Math.round(projection.ms),
    totalMeasuredMs: Math.round(sidebarScope.ms + command.ms + saved.ms + broadcast.ms + projection.ms),
    mbStringified: Math.round((saved.value.length + broadcast.value.length) / 1024 / 1024),
    changed: command.value.changed,
    createTabCalls: calls.createTab,
    createWindowCalls: calls.createWindow,
    restoreSessionCalls: calls.restoreSession,
    nodes: Object.keys(command.value.state.nodes).length,
    rows: projection.value.rows.length
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
