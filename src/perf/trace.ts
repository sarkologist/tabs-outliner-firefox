export type TraceSource = "sidebar" | "background";

export type TraceDetailValue = string | number | boolean | null | undefined;

export type TraceDetail = Record<string, TraceDetailValue>;

export type TraceEntry = {
  source: TraceSource;
  name: string;
  atMs: number;
  durationMs?: number;
  detail?: Record<string, string | number | boolean | null>;
};

export type TraceSnapshot = {
  enabled: boolean;
  maxEntries: number;
  entries: TraceEntry[];
};

export type TraceSummaryRow = {
  name: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
};

export type PerformanceTracerClock = {
  timeOrigin: number;
  now(): number;
};

export type PerformanceTracer = {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  clear(): void;
  mark(name: string, detail?: TraceDetail): void;
  record(name: string, durationMs: number, detail?: TraceDetail): void;
  measure<T>(name: string, fn: () => T): T;
  measure<T>(name: string, detail: TraceDetail | undefined, fn: () => T): T;
  measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T>;
  measureAsync<T>(name: string, detail: TraceDetail | undefined, fn: () => Promise<T>): Promise<T>;
  snapshot(): TraceSnapshot;
};

const DEFAULT_MAX_ENTRIES = 500;

export function createPerformanceTracer(
  source: TraceSource,
  options: {
    enabled?: boolean;
    maxEntries?: number;
    clock?: PerformanceTracerClock;
  } = {}
): PerformanceTracer {
  const clock = options.clock ?? defaultClock();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let enabled = options.enabled ?? false;
  const entries: TraceEntry[] = [];

  function isEnabled(): boolean {
    return enabled;
  }

  function setEnabled(nextEnabled: boolean): void {
    enabled = nextEnabled;
  }

  function clear(): void {
    entries.length = 0;
  }

  function mark(name: string, detail?: TraceDetail): void {
    if (!enabled) {
      return;
    }

    push({
      source,
      name,
      atMs: currentTimeMs(clock),
      ...normalizedDetail(detail)
    });
  }

  function record(name: string, durationMs: number, detail?: TraceDetail): void {
    if (!enabled) {
      return;
    }

    push({
      source,
      name,
      atMs: currentTimeMs(clock),
      durationMs,
      ...normalizedDetail(detail)
    });
  }

  function measure<T>(
    name: string,
    detailOrFn: TraceDetail | (() => T) | undefined,
    maybeFn?: () => T
  ): T {
    const detail = typeof detailOrFn === "function" ? undefined : detailOrFn;
    const fn = typeof detailOrFn === "function" ? detailOrFn : maybeFn;
    if (!fn) {
      throw new Error("measure requires a function");
    }
    if (!enabled) {
      return fn();
    }

    const start = clock.now();
    const atMs = currentTimeMs(clock);
    try {
      return fn();
    } finally {
      push({
        source,
        name,
        atMs,
        durationMs: clock.now() - start,
        ...normalizedDetail(detail)
      });
    }
  }

  async function measureAsync<T>(
    name: string,
    detailOrFn: TraceDetail | (() => Promise<T>) | undefined,
    maybeFn?: () => Promise<T>
  ): Promise<T> {
    const detail = typeof detailOrFn === "function" ? undefined : detailOrFn;
    const fn = typeof detailOrFn === "function" ? detailOrFn : maybeFn;
    if (!fn) {
      throw new Error("measureAsync requires a function");
    }
    if (!enabled) {
      return fn();
    }

    const start = clock.now();
    const atMs = currentTimeMs(clock);
    try {
      return await fn();
    } finally {
      push({
        source,
        name,
        atMs,
        durationMs: clock.now() - start,
        ...normalizedDetail(detail)
      });
    }
  }

  function snapshot(): TraceSnapshot {
    return {
      enabled,
      maxEntries,
      entries: entries.map((entry) => ({
        ...entry,
        ...(entry.detail ? { detail: { ...entry.detail } } : {})
      }))
    };
  }

  function push(entry: TraceEntry): void {
    entries.push(entry);
    if (entries.length > maxEntries) {
      entries.splice(0, entries.length - maxEntries);
    }
  }

  return {
    isEnabled,
    setEnabled,
    clear,
    mark,
    record,
    measure,
    measureAsync,
    snapshot
  };
}

export function summarizeTraceEvents(entries: readonly TraceEntry[]): TraceSummaryRow[] {
  const rowsByName = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  for (const entry of entries) {
    if (typeof entry.durationMs !== "number") {
      continue;
    }

    const existing = rowsByName.get(entry.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    existing.count += 1;
    existing.totalMs += entry.durationMs;
    existing.maxMs = Math.max(existing.maxMs, entry.durationMs);
    rowsByName.set(entry.name, existing);
  }

  return [...rowsByName.entries()]
    .map(([name, row]) => ({
      name,
      count: row.count,
      totalMs: round(row.totalMs),
      avgMs: round(row.totalMs / row.count),
      maxMs: round(row.maxMs)
    }))
    .sort((left, right) => right.totalMs - left.totalMs || left.name.localeCompare(right.name));
}

function defaultClock(): PerformanceTracerClock {
  return {
    get timeOrigin() {
      return globalThis.performance?.timeOrigin ?? Date.now();
    },
    now: () => globalThis.performance?.now() ?? 0
  };
}

function currentTimeMs(clock: PerformanceTracerClock): number {
  return clock.timeOrigin + clock.now();
}

function normalizedDetail(detail: TraceDetail | undefined): {
  detail?: Record<string, string | number | boolean | null>;
} {
  if (!detail) {
    return {};
  }

  const normalized = Object.fromEntries(
    Object.entries(detail).filter(
      (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined
    )
  );
  return Object.keys(normalized).length > 0 ? { detail: normalized } : {};
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
