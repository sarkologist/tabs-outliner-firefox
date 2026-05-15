import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  normalizeStoredZoom,
  resetZoom,
  stepZoom,
  zoomCssMetrics
} from "./zoom.js";

describe("outline zoom", () => {
  it("clamps zoom to the supported range", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(1.2)).toBe(1.2);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  it("steps by ten percent and stays inside the supported range", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(MAX_ZOOM, "in")).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, "out")).toBe(MIN_ZOOM);
  });

  it("resets to the default zoom", () => {
    expect(resetZoom()).toBe(DEFAULT_ZOOM);
  });

  it("normalizes stored values", () => {
    expect(normalizeStoredZoom(1.3)).toBe(1.3);
    expect(normalizeStoredZoom(0.1)).toBe(MIN_ZOOM);
    expect(normalizeStoredZoom("1.2")).toBe(DEFAULT_ZOOM);
    expect(normalizeStoredZoom(undefined)).toBe(DEFAULT_ZOOM);
  });

  it("derives CSS metrics from the zoom value", () => {
    expect(zoomCssMetrics(1)).toEqual({
      "--outline-zoom": "1",
      "--outline-font-size": "13px",
      "--node-row-height": "18px",
      "--node-icon-size": "16px",
      "--node-indent": "11px",
      "--node-row-padding-x": "4px",
      "--node-label-padding-x": "3px",
      "--drop-marker-height": "8px",
      "--drop-marker-inside-height": "14px"
    });

    expect(zoomCssMetrics(1.5)).toMatchObject({
      "--outline-zoom": "1.5",
      "--outline-font-size": "19.5px",
      "--node-row-height": "27px",
      "--node-icon-size": "24px",
      "--node-indent": "16.5px"
    });
  });
});
