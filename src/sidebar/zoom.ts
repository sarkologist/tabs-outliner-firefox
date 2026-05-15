export const ZOOM_STORAGE_KEY = "sidebarOutlineZoom";

export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = 0.8;
export const MAX_ZOOM = 1.6;
export const ZOOM_STEP = 0.1;

export type ZoomDirection = "in" | "out";

export type ZoomCssVariable =
  | "--outline-zoom"
  | "--outline-font-size"
  | "--node-row-height"
  | "--node-icon-size"
  | "--node-indent"
  | "--node-row-padding-x"
  | "--node-label-padding-x"
  | "--drop-marker-height"
  | "--drop-marker-inside-height";

export type ZoomCssMetrics = Record<ZoomCssVariable, string>;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM;
  }

  return roundZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)));
}

export function stepZoom(current: number, direction: ZoomDirection): number {
  const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
  return clampZoom(current + delta);
}

export function resetZoom(): number {
  return DEFAULT_ZOOM;
}

export function normalizeStoredZoom(value: unknown): number {
  if (typeof value !== "number") {
    return DEFAULT_ZOOM;
  }

  return clampZoom(value);
}

export function zoomCssMetrics(value: number): ZoomCssMetrics {
  const zoom = clampZoom(value);

  return {
    "--outline-zoom": String(zoom),
    "--outline-font-size": px(13 * zoom),
    "--node-row-height": px(18 * zoom),
    "--node-icon-size": px(16 * zoom),
    "--node-indent": px(11 * zoom),
    "--node-row-padding-x": px(4 * zoom),
    "--node-label-padding-x": px(3 * zoom),
    "--drop-marker-height": px(8 * zoom),
    "--drop-marker-inside-height": px(14 * zoom)
  };
}

function roundZoom(value: number): number {
  return Number(value.toFixed(2));
}

function px(value: number): string {
  return `${Number(value.toFixed(2))}px`;
}
