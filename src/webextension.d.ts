import type { OutlineState, RuntimeTab, RuntimeWindow } from "./model/types.js";

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

type WebExtensionBrowserApi = {
  action: {
    onClicked: Listener<() => void | Promise<void>>;
  };
  sidebarAction: {
    open(): Promise<void>;
    toggle(): Promise<void>;
  };
  runtime: {
    onInstalled: Listener<() => void | Promise<void>>;
    onStartup: Listener<() => void | Promise<void>>;
    onMessage: Listener<(message: unknown, sender: MessageSender) => unknown | Promise<unknown>>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      get(key?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      onChanged: Listener<(changes: Record<string, StorageChange>, areaName: string) => void>;
    };
  };
  windows: {
    getAll(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<RuntimeWindow[]>;
    update(windowId: number, updateInfo: { focused?: boolean }): Promise<RuntimeWindow>;
    remove(windowId: number): Promise<void>;
    create(createData: { url?: string | string[] }): Promise<RuntimeWindow>;
    onRemoved: Listener<(windowId: number) => void | Promise<void>>;
  };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<RuntimeTab[]>;
    update(tabId: number, updateProperties: { active?: boolean }): Promise<RuntimeTab>;
    remove(tabId: number | number[]): Promise<void>;
    create(createProperties: { url: string; windowId?: number; active?: boolean }): Promise<RuntimeTab>;
    move(tabIds: number | number[], moveProperties: { windowId?: number; index: number }): Promise<RuntimeTab | RuntimeTab[]>;
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
  | import("./background/commands.js").BackgroundCommand;

declare global {
  type WebExtensionBrowser = WebExtensionBrowserApi;
  const browser: WebExtensionBrowser;
}

export {};
