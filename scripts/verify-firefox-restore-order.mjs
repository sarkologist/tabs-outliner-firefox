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

const extensionDir = await mkdtemp(path.join(tmpdir(), "tabs-outliner-firefox-restore-order-"));

try {
  await cp(distDir, extensionDir, { recursive: true });
  await installProbe(extensionDir);
  const result = await runProbe(extensionDir);
  const expectedLabels = result.expected.map((tab) => tab.label);
  const immediateLabels = result.immediate.map((tab) => tab.label);
  const settledLabels = result.settled.map((tab) => tab.label);

  if (!result.immediateOk || !result.settledOk) {
    console.error("Firefox restore order mismatch");
    console.error(`expected:  ${expectedLabels.join(" > ")}`);
    console.error(`immediate: ${immediateLabels.join(" > ")}`);
    console.error(`settled:   ${settledLabels.join(" > ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Firefox restore order verified: ${settledLabels.join(" > ")}`);
  }
} finally {
  await rm(extensionDir, { recursive: true, force: true });
}

async function installProbe(sourceDir) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background = {
    scripts: ["probe-index.js"],
    type: "module"
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(sourceDir, "probe-index.js"), probeSource());
}

async function runProbe(sourceDir) {
  const child = spawn("pnpm", [
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
    "--arg=-headless",
    "--pref=devtools.console.stdout.content=true",
    "--verbose"
  ], {
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

function probeSource() {
  return `
const resultPrefix = ${JSON.stringify(resultPrefix)};
const errorPrefix = ${JSON.stringify(errorPrefix)};

const tree = {
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

main().catch((error) => {
  emit(errorPrefix, {
    message: error && error.stack ? error.stack : String(error)
  });
});

async function main() {
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
  const subgroup = Object.values(imported.nodes).find((node) =>
    node.kind === "window" && node.title === "Imported subgroup"
  );
  if (!subgroup) {
    throw new Error("Imported subgroup was not created");
  }

  await controller.handleMessage({ type: "restoreNode", nodeId: subgroup.id });
  const restored = await controller.handleMessage({ type: "getState" });
  const restoredSubgroup = restored.nodes[subgroup.id];
  const windowId = restoredSubgroup && restoredSubgroup.live && restoredSubgroup.live.windowId;
  if (typeof windowId !== "number") {
    throw new Error("Imported subgroup was not restored to a runtime window");
  }

  const expected = outlineTabs(restored, subgroup.id, windowId);
  const immediate = await runtimeTabs(windowId);
  await delay(750);
  const settled = await runtimeTabs(windowId);

  emit(resultPrefix, {
    expected,
    immediate,
    settled,
    immediateOk: sameOrder(expected, immediate),
    settledOk: sameOrder(expected, settled)
  });
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

async function runtimeTabs(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  return tabs
    .sort((left, right) => left.index - right.index)
    .map((tab) => ({
      tabId: tab.id,
      index: tab.index,
      label: labelForUrl(tab.url)
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
  console.log(prefix + " " + btoa(JSON.stringify(value)));
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
`;
}
