import type { RuntimeTab, RuntimeWindow, RuntimeWindowState } from "./model/types.js";

type Listener<T extends (...args: never[]) => unknown> = {
  addListener(listener: T): void;
  removeListener(listener: T): void;
};

type MessageSender = {
  tab?: RuntimeTab;
};

type WebExtensionPortApi = {
  name?: string;
  sender?: MessageSender;
  onMessage: Listener<(message: unknown, port: WebExtensionPortApi) => void | Promise<void>>;
  onDisconnect: Listener<(port: WebExtensionPortApi) => void | Promise<void>>;
  postMessage(message: unknown): void;
  disconnect(): void;
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

type WebExtensionAlarm = {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
};

type WebExtensionAlarmCreateInfo = {
  when?: number;
  delayInMinutes?: number;
  periodInMinutes?: number;
};

type WebExtensionDownloadOptions = {
  url: string;
  filename?: string;
  saveAs?: boolean;
  conflictAction?: "uniquify" | "overwrite" | "prompt";
};

type WebExtensionWindowType = "normal" | "popup" | "panel";
type WebExtensionWindowCreateData = {
  url?: string | string[];
  tabId?: number;
  type?: WebExtensionWindowType;
  state?: RuntimeWindowState;
  focused?: boolean;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
};

type WebExtensionBrowserApi = {
  action: {
    onClicked: Listener<() => void | Promise<void>>;
  };
  alarms: {
    create(name: string, alarmInfo?: WebExtensionAlarmCreateInfo): void;
    clear(name: string): Promise<boolean>;
    get(name: string): Promise<WebExtensionAlarm | undefined>;
    onAlarm: Listener<(alarm: WebExtensionAlarm) => void | Promise<void>>;
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
    onConnect?: Listener<(port: WebExtensionPortApi) => void | Promise<void>>;
    connect?(connectInfo?: { name?: string }): WebExtensionPortApi;
    sendMessage(message: unknown): Promise<unknown>;
    getURL(path: string): string;
    openOptionsPage(): Promise<void>;
  };
  downloads: {
    download(options: WebExtensionDownloadOptions): Promise<number>;
  };
  storage: {
    onChanged: Listener<
      (changes: Record<string, StorageChange>, areaName: string) => void | Promise<void>
    >;
    local: {
      get(
        key?: string | string[] | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    // Ephemeral, in-memory, browser-session-scoped storage (Firefox 115+, MV3). Optional because
    // older callers and test fakes only stub `local`; feature-detect before use. Used to keep the
    // write-activity debug log alive across the background event page's idle/wake cycles without
    // any disk write (storage.local writes are a tracked perf cost; see write-log.ts).
    session?: {
      get(
        key?: string | string[] | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  windows: {
    WINDOW_ID_NONE: number;
    getCurrent(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<RuntimeWindow>;
    get(
      windowId: number,
      getInfo?: { populate?: boolean; windowTypes?: string[] }
    ): Promise<RuntimeWindow>;
    getAll(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<RuntimeWindow[]>;
    update(
      windowId: number,
      updateInfo: { focused?: boolean; state?: RuntimeWindowState }
    ): Promise<RuntimeWindow>;
    remove(windowId: number): Promise<void>;
    create(createData: WebExtensionWindowCreateData): Promise<RuntimeWindow>;
    onFocusChanged: Listener<(windowId: number) => void | Promise<void>>;
    onBoundsChanged?: Listener<(window: RuntimeWindow) => void | Promise<void>>;
    onRemoved: Listener<(windowId: number) => void | Promise<void>>;
  };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<RuntimeTab[]>;
    update(tabId: number, updateProperties: { active?: boolean }): Promise<RuntimeTab>;
    remove(tabId: number | number[]): Promise<void>;
    create(createProperties: {
      url: string;
      windowId?: number;
      active?: boolean;
    }): Promise<RuntimeTab>;
    move(
      tabIds: number | number[],
      moveProperties: { windowId?: number; index: number }
    ): Promise<RuntimeTab | RuntimeTab[]>;
    onActivated: Listener<
      (activeInfo: {
        tabId: number;
        windowId: number;
        previousTabId?: number;
      }) => void | Promise<void>
    >;
    onAttached?: Listener<
      (
        tabId: number,
        attachInfo: { newWindowId: number; newPosition: number }
      ) => void | Promise<void>
    >;
    onCreated: Listener<(tab: RuntimeTab) => void | Promise<void>>;
    onDetached?: Listener<
      (
        tabId: number,
        detachInfo: { oldWindowId: number; oldPosition: number }
      ) => void | Promise<void>
    >;
    onMoved?: Listener<
      (
        tabId: number,
        moveInfo: { windowId: number; fromIndex: number; toIndex: number }
      ) => void | Promise<void>
    >;
    onUpdated: Listener<
      (tabId: number, changeInfo: Partial<RuntimeTab>, tab: RuntimeTab) => void | Promise<void>
    >;
    onRemoved: Listener<
      (
        tabId: number,
        removeInfo: { windowId: number; isWindowClosing: boolean }
      ) => void | Promise<void>
    >;
  };
  sessions: {
    getRecentlyClosed(filter?: { maxResults?: number }): Promise<WebExtensionSession[]>;
    restore(sessionId: string): Promise<WebExtensionSession>;
    onChanged: Listener<() => void | Promise<void>>;
  };
};

declare global {
  type WebExtensionBrowser = WebExtensionBrowserApi;
  type WebExtensionPort = WebExtensionPortApi;
  const browser: WebExtensionBrowser;
}

export {};
