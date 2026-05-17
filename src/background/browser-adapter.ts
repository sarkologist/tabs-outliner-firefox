import type { BrowserAdapter, RestoredSession } from "./adapter.js";
import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

export function createBrowserAdapter(api: WebExtensionBrowser = browser): BrowserAdapter {
  return {
    async focusTab(tabId, windowId) {
      await api.windows.update(windowId, { focused: true });
      await api.tabs.update(tabId, { active: true });
    },

    async closeTab(tabId) {
      await api.tabs.remove(tabId);
    },

    async closeTabs(tabIds) {
      if (tabIds.length === 0) {
        return;
      }
      await api.tabs.remove(tabIds);
    },

    async closeWindow(windowId) {
      await api.windows.remove(windowId);
    },

    async restoreSession(sessionId) {
      const session = normalizeSession(await api.sessions.restore(sessionId));
      if (session.window && (session.window.tabs?.length ?? 0) === 0) {
        session.window = {
          ...session.window,
          tabs: (await api.tabs.query({ windowId: session.window.id })).map(normalizeTab)
        };
      }
      return session;
    },

    async createTab(createProperties) {
      return normalizeTab(await api.tabs.create(createProperties));
    },

    async createWindow(createData) {
      const windowInfo = normalizeWindow(await api.windows.create(createData));
      if ((windowInfo.tabs?.length ?? 0) > 0) {
        return windowInfo;
      }

      return {
        ...windowInfo,
        tabs: (await api.tabs.query({ windowId: windowInfo.id })).map(normalizeTab)
      };
    },

    async moveTabs(tabIds, moveProperties) {
      await api.tabs.move(tabIds, moveProperties);
    }
  };
}

function normalizeSession(session: RestoredSession): RestoredSession {
  const normalized: RestoredSession = {};
  if (session.tab) {
    normalized.tab = normalizeTab(session.tab);
  }
  if (session.window) {
    normalized.window = normalizeWindow(session.window);
  }
  return normalized;
}

function normalizeWindow(windowInfo: RuntimeWindow): RuntimeWindow {
  if (typeof windowInfo.id !== "number") {
    throw new Error("Firefox returned a window without an id");
  }

  return {
    id: windowInfo.id,
    focused: Boolean(windowInfo.focused),
    incognito: Boolean(windowInfo.incognito),
    ...(windowInfo.tabs ? { tabs: windowInfo.tabs.map(normalizeTab) } : {})
  };
}

function normalizeTab(tab: RuntimeTab): RuntimeTab {
  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
    throw new Error("Firefox returned a tab without id/windowId");
  }

  return {
    id: tab.id,
    windowId: tab.windowId,
    index: typeof tab.index === "number" ? tab.index : 0,
    active: Boolean(tab.active),
    ...(typeof tab.openerTabId === "number" ? { openerTabId: tab.openerTabId } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    ...(tab.incognito ? { incognito: tab.incognito } : {})
  };
}
