import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const firefoxBinary = process.env.FIREFOX_BINARY ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const resultPrefix = "TABS_OUTLINER_RESTORE_ORDER_RESULT_BASE64";
const errorPrefix = "TABS_OUTLINER_RESTORE_ORDER_ERROR_BASE64";
const options = parseArgs(process.argv.slice(2));

const extensionDir = await mkdtemp(path.join(tmpdir(), "tabs-outliner-firefox-restore-order-"));

try {
  await cp(distDir, extensionDir, { recursive: true });
  await installProbe(extensionDir, options);
  const result = await runProbe(extensionDir, options);
  const expectedLabels = result.expected.map((tab) => tab.label);
  const immediateLabels = result.immediate.map((tab) => tab.label);
  const settledLabels = result.settled.map((tab) => tab.label);
  const closeOk = !options.verifyClose || result.close?.ok === true;

  if (!result.immediateOk || !result.settledOk || !closeOk) {
    console.error("Firefox restore verification failed");
    console.error(`expected:  ${expectedLabels.join(" > ")}`);
    console.error(`immediate: ${immediateLabels.join(" > ")}`);
    console.error(`settled:   ${settledLabels.join(" > ")}`);
    if (options.verifyClose && result.close) {
      console.error(`close:     ${JSON.stringify(result.close)}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Firefox restore order verified: ${settledLabels.join(" > ")}`);
    if (options.verifyClose) {
      console.log(`Firefox TO-close verified: ${result.close.closedNodeIds.join(" > ")}`);
    }
  }
} finally {
  await rm(extensionDir, { recursive: true, force: true });
}

async function installProbe(sourceDir, options) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background = {
    scripts: ["probe-index.js"],
    type: "module"
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(sourceDir, "probe-tree.json"), JSON.stringify(await probeTree(options)));
  await writeFile(path.join(sourceDir, "probe-index.js"), probeSource(options));
}

async function runProbe(sourceDir, options) {
  const webExtArgs = [
    "exec",
    "web-ext",
    "run",
    "--source-dir",
    sourceDir,
    "--firefox",
    firefoxBinary,
    "--no-config-discovery",
    "--no-reload",
    "--no-input",
    "--pref=devtools.console.stdout.content=true",
    "--verbose"
  ];
  if (!options.headed) {
    webExtArgs.splice(webExtArgs.length - 2, 0, "--arg=-headless");
  }

  const child = spawn("pnpm", webExtArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  let settled = false;
  let timeout;

  return await new Promise((resolve, reject) => {
    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGINT");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
      fn();
    };

    const onChunk = (chunk) => {
      output += chunk.toString("utf8");
      const result = extractPayload(output, resultPrefix);
      if (result) {
        finish(() => resolve(result));
        return;
      }
      const error = extractPayload(output, errorPrefix);
      if (error) {
        finish(() => reject(new Error(error.message ?? JSON.stringify(error))));
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(() =>
          reject(new Error(`web-ext exited before probe result (code ${code}, signal ${signal})\n${output}`))
        );
      }
    });

    timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for Firefox restore-order probe\n${output}`)));
    }, 45_000);
  });
}

function extractPayload(output, prefix) {
  const match = new RegExp(`${prefix} ([A-Za-z0-9+/=]+)`).exec(output);
  if (!match?.[1]) {
    return undefined;
  }
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

async function probeTree(options) {
  if (!options.treePath) {
    return defaultTree();
  }
  return JSON.parse(await readFile(options.treePath, "utf8"));
}

function parseArgs(args) {
  const parsed = {
    restoreTitle: "Imported subgroup",
    restoreOccurrence: 1,
    settleMs: 750,
    verifyClose: false,
    headed: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--tree") {
      const value = args[++index];
      if (!value) {
        throw new Error("--tree requires a path");
      }
      parsed.treePath = path.resolve(value);
    } else if (arg === "--restore-title") {
      const value = args[++index];
      if (!value) {
        throw new Error("--restore-title requires a title");
      }
      parsed.restoreTitle = value;
    } else if (arg === "--restore-occurrence") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--restore-occurrence requires a positive integer");
      }
      parsed.restoreOccurrence = value;
    } else if (arg === "--settle-ms") {
      const value = Number(args[++index]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--settle-ms requires a non-negative number");
      }
      parsed.settleMs = value;
    } else if (arg === "--verify-close") {
      parsed.verifyClose = true;
    } else if (arg === "--headed") {
      parsed.headed = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function probeSource(options) {
  return `
const resultPrefix = ${JSON.stringify(resultPrefix)};
const errorPrefix = ${JSON.stringify(errorPrefix)};
const restoreTitle = ${JSON.stringify(options.restoreTitle)};
const restoreOccurrence = ${JSON.stringify(options.restoreOccurrence)};
const settleMs = ${JSON.stringify(options.settleMs)};
const verifyClose = ${JSON.stringify(options.verifyClose)};

main().catch((error) => {
  emit(errorPrefix, {
    message: error && error.stack ? error.stack : String(error)
  });
});

async function main() {
  const tree = await fetch(browser.runtime.getURL("probe-tree.json")).then((response) => response.json());
  await browser.storage.local.clear();
  const [{ createBrowserAdapter }, { createBackgroundController }] = await Promise.all([
    import("./background/browser-adapter.js"),
    import("./background/controller.js")
  ]);
  const controller = createBackgroundController({
    api: browser,
    adapter: createBrowserAdapter(browser)
  });

  await controller.handleMessage({ type: "importTree", tree });
  const imported = await controller.handleMessage({ type: "getState" });
  const matchingTargets = Object.values(imported.nodes).filter((node) =>
    (node.kind === "window" || node.kind === "tab") && node.title === restoreTitle
  );
  const subgroup = matchingTargets[restoreOccurrence - 1];
  if (!subgroup) {
    throw new Error(
      "Restore target was not created: " + restoreTitle +
      " occurrence " + restoreOccurrence +
      " of " + matchingTargets.length
    );
  }

  await controller.handleMessage({ type: "restoreNode", nodeId: subgroup.id });
  const restored = await controller.handleMessage({ type: "getState" });
  const restoredSubgroup = restored.nodes[subgroup.id];
  const windowId = restoredSubgroup && restoredSubgroup.live && restoredSubgroup.live.windowId;
  if (typeof windowId !== "number") {
    throw new Error("Restore target was not restored to a runtime window: " + restoreTitle);
  }

  const expected = outlineTabs(restored, subgroup.id, windowId);
  const expectedLabelsByTabId = new Map(expected.map((tab) => [tab.tabId, tab.label]));
  const immediate = await runtimeTabs(windowId, expectedLabelsByTabId);
  await delay(settleMs);
  const settled = await runtimeTabs(windowId, expectedLabelsByTabId);
  const close = verifyClose
    ? await verifyToClose(controller, restored, subgroup.id, windowId, settleMs)
    : undefined;

  emit(resultPrefix, {
    expected,
    immediate,
    settled,
    immediateOk: sameOrder(expected, immediate),
    settledOk: sameOrder(expected, settled),
    ...(close ? { close } : {})
  });
}

async function verifyToClose(controller, restored, rootId, windowId, settleMs) {
  const closeNodeIds = outlineLiveRuntimeNodeIds(restored, rootId, windowId);
  const rootBeforeClose = restored.nodes[rootId];
  const parentId = rootBeforeClose && rootBeforeClose.parentId;

  await controller.handleMessage({ type: "closeNode", nodeId: rootId });
  await delay(settleMs);

  const closed = await controller.handleMessage({ type: "getState" });
  const runtimeWindowOpen = await browser.windows.get(windowId)
    .then(() => true)
    .catch(() => false);
  const missingNodeIds = closeNodeIds.filter((nodeId) => !closed.nodes[nodeId]);
  const staleLiveNodeIds = closeNodeIds.filter((nodeId) => {
    const node = closed.nodes[nodeId];
    return node && (node.status !== "closed" || node.live);
  });
  const parentStillContains = parentId
    ? closed.nodes[parentId]?.childIds?.includes(rootId) === true
    : closed.rootIds.includes(rootId);

  return {
    ok: missingNodeIds.length === 0 &&
      staleLiveNodeIds.length === 0 &&
      !runtimeWindowOpen &&
      parentStillContains,
    closedNodeIds: closeNodeIds,
    missingNodeIds,
    staleLiveNodeIds,
    runtimeWindowOpen,
    parentStillContains
  };
}

function outlineLiveRuntimeNodeIds(state, rootId, windowId) {
  const ids = [];
  const visited = new Set();
  const visit = (nodeId) => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    if (
      node.status === "live" &&
      node.live &&
      (
        (node.kind === "window" && node.live.windowId === windowId) ||
        (node.kind === "tab" && node.live.windowId === windowId)
      )
    ) {
      ids.push(node.id);
    }
    for (const childId of node.childIds ?? []) {
      visit(childId);
    }
  };
  visit(rootId);
  return ids;
}

function outlineTabs(state, rootId, windowId) {
  const tabs = [];
  const visited = new Set();
  const visit = (nodeId) => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    if (
      node.kind === "tab" &&
      node.status === "live" &&
      node.live &&
      node.live.windowId === windowId &&
      typeof node.live.tabId === "number"
    ) {
      tabs.push({
        nodeId: node.id,
        tabId: node.live.tabId,
        label: node.title ?? node.url ?? node.id
      });
    }
    for (const childId of node.childIds ?? []) {
      visit(childId);
    }
  };
  visit(rootId);
  return tabs;
}

async function runtimeTabs(windowId, expectedLabelsByTabId) {
  const tabs = await browser.tabs.query({ windowId });
  return tabs
    .sort((left, right) => left.index - right.index)
    .map((tab) => ({
      tabId: tab.id,
      index: tab.index,
      label: expectedLabelsByTabId.get(tab.id) ?? labelForUrl(tab.url)
    }));
}

function labelForUrl(url) {
  const match = /\\/restore-order\\/([^/?#]+)/.exec(url ?? "");
  return match ? match[1] : (url ?? "");
}

function sameOrder(expected, actual) {
  return expected.length === actual.length &&
    expected.every((tab, index) => actual[index] && actual[index].tabId === tab.tabId);
}

function emit(prefix, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  console.log(prefix + " " + btoa(binary));
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
`;
}

function defaultTree() {
  return {
    schema: "tabs-outliner-tree",
    version: 1,
    exportedAt: "2026-06-06T00:00:00.000Z",
    roots: [
      {
        kind: "window",
        title: "Imported parent",
        children: [
          {
            kind: "window",
            title: "Imported subgroup",
            children: [
              {
                kind: "tab",
                title: "Root",
                url: "https://example.invalid/tabs-outliner/restore-order/root",
                children: [
                  {
                    kind: "tab",
                    title: "Branch A",
                    url: "https://example.invalid/tabs-outliner/restore-order/branch-a",
                    children: [
                      {
                        kind: "tab",
                        title: "Branch A child",
                        url: "https://example.invalid/tabs-outliner/restore-order/branch-a-child",
                        children: [
                          {
                            kind: "tab",
                            title: "Branch A grandchild",
                            url: "https://example.invalid/tabs-outliner/restore-order/branch-a-grandchild",
                            children: []
                          }
                        ]
                      }
                    ]
                  },
                  {
                    kind: "tab",
                    title: "Branch B",
                    url: "https://example.invalid/tabs-outliner/restore-order/branch-b",
                    children: [
                      {
                        kind: "tab",
                        title: "Branch B child",
                        url: "https://example.invalid/tabs-outliner/restore-order/branch-b-child",
                        children: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}
