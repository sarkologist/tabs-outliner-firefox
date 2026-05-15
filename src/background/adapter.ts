import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

export type RestoredSession = {
  tab?: RuntimeTab;
  window?: RuntimeWindow;
};

export type BrowserAdapter = {
  focusTab(tabId: number, windowId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  closeWindow(windowId: number): Promise<void>;
  restoreSession(sessionId: string): Promise<RestoredSession>;
  createTab(createProperties: { url: string; windowId?: number; active?: boolean }): Promise<RuntimeTab>;
  createWindow(createData: { url?: string | string[]; tabId?: number }): Promise<RuntimeWindow>;
  moveTabs(tabIds: number[], moveProperties: { windowId: number; index: number }): Promise<void>;
};
