import type { OutlineState, RuntimeTab, RuntimeWindow } from "./model/types.js";
import type { HistoryStatus } from "./background/history.js";

type Listener<T extends (...args: never[]) => unknown> = {
  addListener(listener: T): void;
  removeListener(listener: T): void;
};

type MessageSender = {
  tab?: RuntimeTab;
};

type StorageChange = {
  oldValue?: unknown;
  newValue?: unknown;
};

type WebExtensionSession = {
  tab?: RuntimeTab;
  window?: RuntimeWindow;
};

type WebExtensionCommand = {
  name?: string;
  description?: string;
  shortcut?: string;
};

type WebExtensionBrowserApi = {
  action: {
    onClicked: Listener<() => void | Promise<void>>;
  };
  sidebarAction: {
    open(): Promise<void>;
    toggle(): Promise<void>;
  };
  commands: {
    onCommand: Listener<(command: string) => void | Promise<void>>;
    getAll(): Promise<WebExtensionCommand[]>;
    update(details: { name: string; shortcut?: string; description?: string }): Promise<void>;
    reset(name: string): Promise<void>;
  };
  runtime: {
    onInstalled: Listener<() => void | Promise<void>>;
    onStartup: Listener<() => void | Promise<void>>;
    onMessage: Listener<(message: unknown, sender: MessageSender) => unknown | Promise<unknown>>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    onChanged: Listener<(changes: Record<string, StorageChange>, areaName: string) => void | Promise<void>>;
    local: {
      get(key?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  windows: {
    WINDOW_ID_NONE: number;
    get(windowId: number, getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<RuntimeWindow>;
    getAll(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<RuntimeWindow[]>;
    update(windowId: number, updateInfo: { focused?: boolean }): Promise<RuntimeWindow>;
    remove(windowId: number): Promise<void>;
    create(createData: { url?: string | string[]; tabId?: number }): Promise<RuntimeWindow>;
    onFocusChanged: Listener<(windowId: number) => void | Promise<void>>;
    onRemoved: Listener<(windowId: number) => void | Promise<void>>;
  };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<RuntimeTab[]>;
    update(tabId: number, updateProperties: { active?: boolean }): Promise<RuntimeTab>;
    remove(tabId: number | number[]): Promise<void>;
    create(createProperties: { url: string; windowId?: number; active?: boolean }): Promise<RuntimeTab>;
    move(tabIds: number | number[], moveProperties: { windowId?: number; index: number }): Promise<RuntimeTab | RuntimeTab[]>;
    onActivated: Listener<(activeInfo: { tabId: number; windowId: number; previousTabId?: number }) => void | Promise<void>>;
    onCreated: Listener<(tab: RuntimeTab) => void | Promise<void>>;
    onUpdated: Listener<(tabId: number, changeInfo: Partial<RuntimeTab>, tab: RuntimeTab) => void | Promise<void>>;
    onRemoved: Listener<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void | Promise<void>>;
  };
  sessions: {
    getRecentlyClosed(filter?: { maxResults?: number }): Promise<WebExtensionSession[]>;
    restore(sessionId: string): Promise<WebExtensionSession>;
    onChanged: Listener<() => void | Promise<void>>;
  };
};

type OutlineMessage =
  | {
      type: "stateUpdated";
      state: OutlineState;
    }
  | ({
      type: "historyStatus";
    } & HistoryStatus)
  | import("./background/commands.js").BackgroundCommand;

declare global {
  type WebExtensionBrowser = WebExtensionBrowserApi;
  const browser: WebExtensionBrowser;
}

export {};
