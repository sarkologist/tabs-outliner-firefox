import { shortcutMatchesEvent, type AppPreferences } from "../preferences.js";
import {
  DEFAULT_ZOOM,
  ZOOM_STORAGE_KEY,
  clampZoom,
  normalizeStoredZoom,
  resetZoom,
  stepZoom,
  type ZoomDirection,
  zoomCssMetrics
} from "./zoom.js";

const WHEEL_ZOOM_THRESHOLD_PX = 80;

type ZoomControllerDeps = {
  getAppPreferences: () => AppPreferences;
  requestVirtualRender: () => void;
};

export type ZoomController = {
  loadPreference(): Promise<void>;
};

export function createZoomController(deps: ZoomControllerDeps): ZoomController {
  const { getAppPreferences, requestVirtualRender } = deps;

  let currentZoom = DEFAULT_ZOOM;
  let wheelZoomDelta = 0;

  applyZoom(currentZoom);
  registerShortcuts();

  async function loadPreference(): Promise<void> {
    const stored = await browser.storage.local.get(ZOOM_STORAGE_KEY).catch(() => undefined);
    if (!stored) {
      return;
    }

    setZoom(normalizeStoredZoom(stored[ZOOM_STORAGE_KEY]), { persist: false });
  }

  function registerShortcuts(): void {
    document.addEventListener("keydown", (event) => {
      const action = zoomKeyboardAction(event);
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      wheelZoomDelta = 0;

      if (action === "reset") {
        setZoom(resetZoom());
        return;
      }

      setZoom(stepZoom(currentZoom, action));
    });

    document.addEventListener(
      "wheel",
      (event) => {
        if (!isZoomModifierEvent(event)) {
          return;
        }

        const deltaY = normalizedWheelDeltaY(event);
        if (deltaY === 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        wheelZoomDelta += deltaY;

        if (Math.abs(wheelZoomDelta) < WHEEL_ZOOM_THRESHOLD_PX) {
          return;
        }

        const direction: ZoomDirection = wheelZoomDelta < 0 ? "in" : "out";
        wheelZoomDelta = 0;
        setZoom(stepZoom(currentZoom, direction));
      },
      { passive: false }
    );
  }

  function isZoomModifierEvent(event: KeyboardEvent | WheelEvent): boolean {
    return (event.ctrlKey || event.metaKey) && !event.altKey;
  }

  function zoomKeyboardAction(event: KeyboardEvent): ZoomDirection | "reset" | undefined {
    const appPreferences = getAppPreferences();
    if (shortcutMatchesEvent(appPreferences.shortcuts.zoomIn, event)) {
      return "in";
    }

    if (shortcutMatchesEvent(appPreferences.shortcuts.zoomOut, event)) {
      return "out";
    }

    if (shortcutMatchesEvent(appPreferences.shortcuts.zoomReset, event)) {
      return "reset";
    }

    return undefined;
  }

  function normalizedWheelDeltaY(event: WheelEvent): number {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return event.deltaY * 16;
    }

    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return event.deltaY * window.innerHeight;
    }

    return event.deltaY;
  }

  function setZoom(zoom: number, options: { persist?: boolean } = {}): void {
    const nextZoom = clampZoom(zoom);
    if (nextZoom === currentZoom) {
      return;
    }

    currentZoom = nextZoom;
    applyZoom(currentZoom);
    requestVirtualRender();

    if (options.persist ?? true) {
      void saveZoomPreference(currentZoom);
    }
  }

  function applyZoom(zoom: number): void {
    const metrics = zoomCssMetrics(zoom);
    for (const [name, value] of Object.entries(metrics)) {
      document.documentElement.style.setProperty(name, value);
    }
  }

  async function saveZoomPreference(zoom: number): Promise<void> {
    await browser.storage.local.set({ [ZOOM_STORAGE_KEY]: zoom }).catch(() => undefined);
  }

  return { loadPreference };
}
