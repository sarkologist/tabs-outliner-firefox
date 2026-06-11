// Shared fault-injection storage mock for storage/journal tests. It wraps an in-memory
// `storage.local` with programmable failures so torn-write, failed-set, and restart
// scenarios become testable (see docs/storage-rearchitecture 03-WORKFLOW-FIXES W-4).

export type FaultyStorage = {
  api: WebExtensionBrowser;
  // The next storage.local.set rejects without applying any key.
  failNextSet(error?: Error): void;
  // The next storage.local.set applies only the first `keepKeys` keys (in insertion order)
  // and then resolves -- a crash-consistent torn multi-key write.
  tearNextSet(keepKeys: number): void;
  // Inject latency into every get/set/remove (real time; do not combine with fake timers).
  setLatencyMs(ms: number): void;
  // Read the current persisted contents without going through the api.
  snapshot(): Record<string, unknown>;
  // Number of times set has been invoked (including failed/torn ones).
  setCallCount(): number;
};

export function createFaultyStorage(initial: Record<string, unknown> = {}): FaultyStorage {
  const store = new Map<string, unknown>(Object.entries(initial));
  let failNextError: Error | undefined;
  let failNextArmed = false;
  let tearKeepKeys: number | undefined;
  let latencyMs = 0;
  let setCalls = 0;

  const delay = async (): Promise<void> => {
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }
  };

  const api = {
    storage: {
      local: {
        get: async (
          key?: string | string[] | Record<string, unknown> | null
        ): Promise<Record<string, unknown>> => {
          await delay();
          if (typeof key === "string") {
            return { [key]: store.get(key) };
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((entry) => [entry, store.get(entry)]));
          }
          if (key && typeof key === "object") {
            return Object.fromEntries(
              Object.entries(key).map(([name, fallback]) => [name, store.has(name) ? store.get(name) : fallback])
            );
          }
          return Object.fromEntries(store);
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          await delay();
          setCalls += 1;
          if (failNextArmed) {
            failNextArmed = false;
            const error = failNextError ?? new Error("simulated storage.local.set failure");
            failNextError = undefined;
            throw error;
          }
          const entries = Object.entries(items);
          const applied = tearKeepKeys !== undefined ? entries.slice(0, Math.max(0, tearKeepKeys)) : entries;
          tearKeepKeys = undefined;
          for (const [name, value] of applied) {
            store.set(name, value);
          }
        },
        remove: async (keys: string | string[]): Promise<void> => {
          await delay();
          for (const name of Array.isArray(keys) ? keys : [keys]) {
            store.delete(name);
          }
        }
      }
    }
  } as unknown as WebExtensionBrowser;

  return {
    api,
    failNextSet(error?: Error): void {
      failNextArmed = true;
      failNextError = error;
    },
    tearNextSet(keepKeys: number): void {
      tearKeepKeys = keepKeys;
    },
    setLatencyMs(ms: number): void {
      latencyMs = ms;
    },
    snapshot(): Record<string, unknown> {
      return Object.fromEntries(store);
    },
    setCallCount(): number {
      return setCalls;
    }
  };
}
