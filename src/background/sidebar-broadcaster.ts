import type { PerformanceTracer } from "../perf/trace.js";

// Owns the set of connected sidebar ports and the transport for pushing messages to them
// (with a runtime.sendMessage fallback when no port is connected). Extracted from
// createBackgroundController (no behavior change) as the first Track-B factory decomposition:
// a self-contained state slice (sidebarPorts) behind a small interface.

const SIDEBAR_PORT_NAME = "tabs-outliner-sidebar";

type SidebarMessage = { type: string } & Record<string, unknown>;

export type SidebarBroadcasterDeps = {
  perfTrace: PerformanceTracer;
  sendRuntimeMessage: (message: SidebarMessage) => Promise<unknown>;
};

export type SidebarBroadcaster = {
  /** Register a freshly connected port; ignores non-sidebar ports and self-removes on disconnect. */
  registerPort(port: WebExtensionPort): void;
  /** Post to the sidebar inside a perf-trace measure span. */
  broadcast(message: SidebarMessage): void;
  /** Post to connected ports, or fall back to runtime.sendMessage when none are connected. */
  post(message: SidebarMessage): void;
};

export function createSidebarBroadcaster(deps: SidebarBroadcasterDeps): SidebarBroadcaster {
  const { perfTrace, sendRuntimeMessage } = deps;
  const sidebarPorts = new Set<WebExtensionPort>();

  function registerPort(port: WebExtensionPort): void {
    if (port.name !== SIDEBAR_PORT_NAME) {
      return;
    }

    sidebarPorts.add(port);
    port.onDisconnect.addListener(() => {
      sidebarPorts.delete(port);
    });
  }

  function broadcast(message: SidebarMessage): void {
    perfTrace.measure("background.runtime.broadcast", { type: message.type }, () => {
      post(message);
    });
  }

  function post(message: SidebarMessage): void {
    if (sidebarPorts.size > 0) {
      postMessageToSidebarPorts(message);
      return;
    }

    postFallbackRuntimeMessage(message);
  }

  function postMessageToSidebarPorts(message: SidebarMessage): void {
    for (const port of [...sidebarPorts]) {
      try {
        port.postMessage(message);
      } catch (error) {
        sidebarPorts.delete(port);
        perfTrace.mark("background.runtime.port.post.error", {
          type: message.type,
          message: errorText(error)
        });
      }
    }
  }

  function postFallbackRuntimeMessage(message: SidebarMessage): void {
    try {
      void sendRuntimeMessage(message).catch((error) => {
        perfTrace.mark("background.runtime.broadcast.error", {
          type: message.type,
          message: errorText(error)
        });
      });
    } catch (error) {
      perfTrace.mark("background.runtime.broadcast.error", {
        type: message.type,
        message: errorText(error)
      });
    }
  }

  return { registerPort, broadcast, post };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
