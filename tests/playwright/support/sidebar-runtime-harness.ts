import type { Page } from "@playwright/test";

import {
  createBackgroundController,
  type BackgroundController
} from "../../../src/background/controller";
import type { OutlineDiagnostics } from "../../../src/background/diagnostics";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../../../src/model/types";
import {
  createFakeWebExtensionRuntime,
  type FakeRuntimeProtocolLog,
  type FakeRuntimeSideEffect,
  type FakeWebExtensionRuntime
} from "../../../src/test/fake-webextension-runtime.test-support";

export type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

type SidebarRuntimeHarnessOptions = {
  windows: RuntimeWindow[];
  tabs: RuntimeTab[];
  initialStorage?: Record<string, unknown>;
  now?: () => number;
};

export type AttachedSidebarPage = {
  page: Page;
  issues: ConsoleIssue[];
  load(): Promise<void>;
  clearProtocol(): void;
  protocol(): FakeRuntimeProtocolLog[];
  sideEffects(): FakeRuntimeSideEffect[];
  profileSummary(): Promise<unknown>;
};

export type SidebarRuntimeHarness = {
  runtime: FakeWebExtensionRuntime;
  controller: BackgroundController;
  attachPage(page: Page): Promise<AttachedSidebarPage>;
  waitForIdle(): Promise<void>;
  state(): Promise<OutlineState>;
  diagnostics(): Promise<OutlineDiagnostics>;
  assertCleanBackground(): Promise<void>;
};

export function createSidebarRuntimeHarness(
  options: SidebarRuntimeHarnessOptions
): SidebarRuntimeHarness {
  const runtime = createFakeWebExtensionRuntime(options.windows, options.tabs, {
    ...(options.initialStorage ? { initialStorage: options.initialStorage } : {})
  });
  const controller = createBackgroundController({
    api: runtime.api,
    now: options.now ?? (() => 1_700_000_000_000)
  });
  const attachedPages = new Set<Page>();

  runtime.addRuntimeBroadcastListener(async (message) => {
    await Promise.all([...attachedPages].map((page) => dispatchRuntimeMessage(page, message)));
  });
  runtime.addStorageChangeListener(async (changes, areaName) => {
    await Promise.all(
      [...attachedPages].map((page) => dispatchStorageChange(page, changes, areaName))
    );
  });

  async function attachPage(page: Page): Promise<AttachedSidebarPage> {
    const issues = collectPageIssues(page);
    attachedPages.add(page);
    page.once("close", () => attachedPages.delete(page));

    await page.exposeBinding("__tabsOutlinerSendMessage", async (_source, message: unknown) =>
      runtime.sendMessageFromPage(message)
    );
    await page.exposeBinding("__tabsOutlinerStorageGet", async (_source, key: unknown) =>
      runtime.api.storage.local.get(key as never)
    );
    await page.exposeBinding("__tabsOutlinerStorageSet", async (_source, items: unknown) => {
      await runtime.api.storage.local.set(items as Record<string, unknown>);
    });
    await page.exposeBinding("__tabsOutlinerStorageRemove", async (_source, keys: unknown) => {
      await runtime.api.storage.local.remove(keys as string | string[]);
    });
    await page.exposeBinding("__tabsOutlinerOpenOptionsPage", async () => {
      await runtime.api.runtime.openOptionsPage();
    });
    await page.exposeBinding("__tabsOutlinerGetURL", (_source, path: unknown) =>
      runtime.api.runtime.getURL(String(path))
    );

    await page.addInitScript(() => {
      const runtimeListeners: Array<(message: unknown) => unknown> = [];
      const storageListeners: Array<
        (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          areaName: string
        ) => unknown
      > = [];
      const testWindow = window as typeof window & {
        __tabsOutlinerDispatchRuntimeMessage?: (message: unknown) => Promise<void>;
        __tabsOutlinerDispatchStorageChange?: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          areaName: string
        ) => Promise<void>;
        __tabsOutlinerSendMessage?: (message: unknown) => Promise<unknown>;
        __tabsOutlinerStorageGet?: (key: unknown) => Promise<Record<string, unknown>>;
        __tabsOutlinerStorageSet?: (items: Record<string, unknown>) => Promise<void>;
        __tabsOutlinerStorageRemove?: (keys: string | string[]) => Promise<void>;
        __tabsOutlinerOpenOptionsPage?: () => Promise<void>;
        __tabsOutlinerGetURL?: (path: string) => string;
      };

      testWindow.__tabsOutlinerDispatchRuntimeMessage = async (message) => {
        for (const listener of [...runtimeListeners]) {
          await listener(structuredClone(message));
        }
      };
      testWindow.__tabsOutlinerDispatchStorageChange = async (changes, areaName) => {
        for (const listener of [...storageListeners]) {
          await listener(structuredClone(changes), areaName);
        }
      };

      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => testWindow.__tabsOutlinerSendMessage?.(message),
          getURL: (path: string) => testWindow.__tabsOutlinerGetURL?.(path) ?? path,
          openOptionsPage: async () => {
            await testWindow.__tabsOutlinerOpenOptionsPage?.();
          },
          onMessage: {
            addListener: (listener: (message: unknown) => unknown) => {
              runtimeListeners.push(listener);
            },
            removeListener: (listener: (message: unknown) => unknown) => {
              const index = runtimeListeners.indexOf(listener);
              if (index >= 0) {
                runtimeListeners.splice(index, 1);
              }
            }
          }
        },
        storage: {
          onChanged: {
            addListener: (
              listener: (
                changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
                areaName: string
              ) => unknown
            ) => {
              storageListeners.push(listener);
            },
            removeListener: (
              listener: (
                changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
                areaName: string
              ) => unknown
            ) => {
              const index = storageListeners.indexOf(listener);
              if (index >= 0) {
                storageListeners.splice(index, 1);
              }
            }
          },
          local: {
            get: async (key?: string | string[] | Record<string, unknown> | null) =>
              testWindow.__tabsOutlinerStorageGet?.(key) ?? {},
            set: async (items: Record<string, unknown>) => {
              await testWindow.__tabsOutlinerStorageSet?.(items);
            },
            remove: async (keys: string | string[]) => {
              await testWindow.__tabsOutlinerStorageRemove?.(keys);
            }
          }
        }
      };
    });

    return {
      page,
      issues,
      async load() {
        await page.goto("/sidebar/sidebar.html");
        await waitForIdle();
      },
      clearProtocol() {
        runtime.protocol.splice(0, runtime.protocol.length);
        runtime.runtimeBroadcasts.splice(0, runtime.runtimeBroadcasts.length);
      },
      protocol() {
        return runtime.protocol.map((entry) => structuredClone(entry));
      },
      sideEffects() {
        return runtime.sideEffects.map((entry) => structuredClone(entry));
      },
      async profileSummary() {
        return page.evaluate(async () => window.tabsOutlinerProfile?.summary?.());
      }
    };
  }

  async function waitForIdle(): Promise<void> {
    for (let pass = 0; pass < 6; pass += 1) {
      await runtime.flush();
      await Promise.all(
        [...attachedPages].map((page) => page.waitForTimeout(0).catch(() => undefined))
      );
      await waitForMacrotask();
      await runtime.flush();
      await controller.handleMessage({ type: "getDiagnostics" }).catch(() => undefined);
    }
  }

  async function state(): Promise<OutlineState> {
    await waitForIdle();
    return controller.ensureState();
  }

  async function diagnostics(): Promise<OutlineDiagnostics> {
    await waitForIdle();
    return controller.handleMessage({ type: "getDiagnostics" }) as Promise<OutlineDiagnostics>;
  }

  async function assertCleanBackground(): Promise<void> {
    const currentState = await state();
    runtime.assertRuntimeModelInvariants(currentState);
    const currentDiagnostics = await diagnostics();
    if (currentDiagnostics.missingRuntimeTabIds.length > 0) {
      throw new Error(
        `Missing runtime tabs: ${currentDiagnostics.missingRuntimeTabIds.join(", ")}`
      );
    }
  }

  return {
    runtime,
    controller,
    attachPage,
    waitForIdle,
    state,
    diagnostics,
    assertCleanBackground
  };
}

function collectPageIssues(page: Page): ConsoleIssue[] {
  const issues: ConsoleIssue[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      issues.push({ kind: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ kind: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    issues.push({
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? ""}`
    });
  });
  return issues;
}

async function dispatchRuntimeMessage(page: Page, message: unknown): Promise<void> {
  await page
    .evaluate(async (payload) => {
      const dispatch = (
        window as typeof window & {
          __tabsOutlinerDispatchRuntimeMessage?: (message: unknown) => Promise<void>;
        }
      ).__tabsOutlinerDispatchRuntimeMessage;
      await dispatch?.(payload);
    }, message)
    .catch(() => undefined);
}

async function dispatchStorageChange(
  page: Page,
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string
): Promise<void> {
  await page
    .evaluate(
      async ({ payload, area }) => {
        const dispatch = (
          window as typeof window & {
            __tabsOutlinerDispatchStorageChange?: (
              changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
              areaName: string
            ) => Promise<void>;
          }
        ).__tabsOutlinerDispatchStorageChange;
        await dispatch?.(payload, area);
      },
      { payload: changes, area: areaName }
    )
    .catch(() => undefined);
}

function waitForMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
