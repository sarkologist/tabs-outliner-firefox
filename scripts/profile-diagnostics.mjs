import { performance } from "node:perf_hooks";

import { computeDiagnostics } from "../dist/background/diagnostics.js";
import { createDiagnosticsScheduler } from "../dist/sidebar/diagnostics-scheduler.js";

function parseArgs(argv) {
  const options = {
    tabs: 50_000,
    requests: 10,
    mode: "coalesced"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tabs" && next) {
      options.tabs = Number.parseInt(next, 10);
      index += 1;
    } else if ((arg === "--requests" || arg === "--count") && next) {
      options.requests = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--mode" && next) {
      options.mode = next;
      index += 1;
    }
  }

  if (!Number.isFinite(options.tabs) || options.tabs < 1) {
    throw new Error("--tabs must be a positive integer");
  }
  if (!Number.isFinite(options.requests) || options.requests < 1) {
    throw new Error("--requests must be a positive integer");
  }
  if (!["immediate", "coalesced"].includes(options.mode)) {
    throw new Error("--mode must be immediate or coalesced");
  }

  return options;
}

function makeState(tabCount) {
  const root = {
    id: "window:10",
    kind: "window",
    status: "live",
    childIds: [],
    title: "Diagnostics Window",
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

  for (let index = 1; index <= tabCount; index += 1) {
    const id = `tab:${index}`;
    root.childIds.push(id);
    state.nodes[id] = index === 1
      ? {
          id,
          kind: "tab",
          status: "live",
          parentId: root.id,
          childIds: [],
          title: "Live Tab",
          url: "https://diagnostics.example/live",
          active: true,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 1, windowId: 10 }
        }
      : {
          id,
          kind: "tab",
          status: "closed",
          parentId: root.id,
          childIds: [],
          title: `Saved ${index}`,
          url: `https://diagnostics.example/${index}`,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 2000 + index,
          restore: {
            url: `https://diagnostics.example/${index}`,
            title: `Saved ${index}`
          }
        };
  }

  return state;
}

function runtimeWindows() {
  return [
    {
      id: 10,
      focused: true,
      incognito: false,
      tabs: [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://diagnostics.example/live",
          title: "Live Tab"
        }
      ]
    }
  ];
}

function measure(fn) {
  const start = performance.now();
  const value = fn();
  return {
    value,
    ms: performance.now() - start
  };
}

class FakeClock {
  nextId = 1;
  timers = new Map();

  setTimeout(callback) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(timerId) {
    this.timers.delete(timerId);
  }

  async runAll() {
    while (this.timers.size > 0) {
      const [timerId, callback] = this.timers.entries().next().value;
      this.timers.delete(timerId);
      callback();
      await Promise.resolve();
    }
  }
}

async function profile(options) {
  const state = makeState(options.tabs);
  const windows = runtimeWindows();
  let diagnosticsLoads = 0;
  let computeDiagnosticsMs = 0;
  let lastDiagnostics;

  async function loadDiagnostics() {
    const computed = measure(() => computeDiagnostics(state, windows));
    diagnosticsLoads += 1;
    computeDiagnosticsMs += computed.ms;
    lastDiagnostics = computed.value;
  }

  const start = performance.now();
  if (options.mode === "immediate") {
    for (let index = 0; index < options.requests; index += 1) {
      await loadDiagnostics();
    }
  } else {
    const clock = new FakeClock();
    const scheduler = createDiagnosticsScheduler(loadDiagnostics, { clock, delayMs: 250 });
    for (let index = 0; index < options.requests; index += 1) {
      scheduler.request();
    }
    await clock.runAll();
  }

  return {
    mode: options.mode,
    tabs: options.tabs,
    requestedRefreshes: options.requests,
    diagnosticsLoads,
    totalMeasuredMs: Math.round(performance.now() - start),
    computeDiagnosticsMs: Math.round(computeDiagnosticsMs),
    runtimeTabCount: lastDiagnostics?.runtimeTabCount ?? 0,
    liveTabNodeCount: lastDiagnostics?.liveTabNodeCount ?? 0,
    closedTabNodeCount: lastDiagnostics?.closedTabNodeCount ?? 0,
    hiddenLiveTabNodeCount: lastDiagnostics?.hiddenLiveTabNodeCount ?? 0
  };
}

const result = await profile(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
