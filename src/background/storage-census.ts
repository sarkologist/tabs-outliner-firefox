import type { IncidentLogDetail } from "./incident-log.js";

// A field census of the storage.local area. It measures the three things that cannot be read
// from the repo or a perf profile because they are properties of the live Firefox profile:
//
//   1. which storage.local backend is active -- a ~1 KB probe `set` that costs more than a
//      few ms means a whole-store-rewrite backend (legacy JSON `storage.local.lz4`), where a
//      tiny write is O(total store); a per-key IndexedDB backend keeps it O(payload);
//   2. how the stored bytes break down by key prefix (what dominates the rewrite cost);
//   3. whether stale v4 node-shard generations are leaking un-swept (nodeShardKeyCount and
//      nodeShardDistinctGenerations well above ~32 / ~3).
//
// It is read-only apart from one self-cleaning probe key, and is meant to run only behind the
// profiling opt-in -- never on the normal startup path. See
// docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md.

export const STORAGE_PROBE_KEY = "tabsOutlinerStorageProbe:v1";

// Large enough to be a realistic small write, small enough that its own bytes are negligible
// next to the store. On a whole-store-rewrite backend even this triggers a full serialize +
// rewrite; on a per-key backend it is one small record.
const PROBE_PAYLOAD_BYTES = 1024;

const STATE_V4_NODE_SHARD_PREFIX = "outline:v4:nodes:";

// First matching prefix wins, so more specific prefixes precede the legacy roots they share a
// stem with (outlineState:v3: before bare outlineState; the incident log before the generic
// tabsOutliner settings). Anything unmatched is bucketed as "other".
const CENSUS_PREFIXES = [
  STATE_V4_NODE_SHARD_PREFIX,
  "outline:v4:journal:",
  "outline:v4:manifest:",
  "outline:v4:bootSnapshot",
  "outline:v4:migrationBackup",
  "outlineState:v3:",
  "outlineState:v2:",
  "outlineHistory",
  "outlineState",
  "tabsOutlinerIncidentLog",
  "tabsOutliner"
] as const;

export type StoragePrefixCensus = {
  prefix: string;
  keyCount: number;
  bytes: number;
};

export type StorageCensusResult = {
  totalKeys: number;
  // Serialized characters (uncompressed JSON.stringify length) across all values. A proxy for
  // serialize cost; on the legacy backend the on-disk file is additionally LZ4-compressed.
  totalBytes: number;
  // Sorted by bytes descending.
  byPrefix: StoragePrefixCensus[];
  nodeShardKeyCount: number;
  // Number of distinct generations among present node-shard keys. ~2-3 is healthy
  // (double-buffered manifests); a large value signals leaked, un-swept generations.
  nodeShardDistinctGenerations: number;
  // Cold 1 KB probe `set` duration (ms). null when the probe was skipped or failed.
  probeSetMs: number | null;
  // A second probe `set` issued immediately after the first. On a debounced whole-store
  // backend this often coalesces and is far cheaper than the cold write.
  probeSetWarmMs: number | null;
  probeError?: string;
};

export type MeasureStorageCensusOptions = {
  now?: () => number;
  // Whether to issue the probe write/remove. Default true. Disable to keep the census purely
  // read-only (e.g. when the caller only wants the byte/key breakdown).
  probe?: boolean;
};

export async function measureStorageCensus(
  api: WebExtensionBrowser,
  options: MeasureStorageCensusOptions = {}
): Promise<StorageCensusResult> {
  const now = options.now ?? Date.now;
  const everything = await api.storage.local.get(null);

  const byPrefix = new Map<string, StoragePrefixCensus>();
  let totalKeys = 0;
  let totalBytes = 0;
  let nodeShardKeyCount = 0;
  const nodeShardGenerations = new Set<number>();

  for (const key of Object.keys(everything)) {
    totalKeys += 1;
    const bytes = approximateValueBytes(everything[key]);
    totalBytes += bytes;
    const prefix = censusPrefix(key);
    const bucket = byPrefix.get(prefix);
    if (bucket) {
      bucket.keyCount += 1;
      bucket.bytes += bytes;
    } else {
      byPrefix.set(prefix, { prefix, keyCount: 1, bytes });
    }
    if (key.startsWith(STATE_V4_NODE_SHARD_PREFIX)) {
      nodeShardKeyCount += 1;
      const generation = Number(key.slice(key.lastIndexOf(":") + 1));
      if (Number.isFinite(generation)) {
        nodeShardGenerations.add(generation);
      }
    }
  }

  const probe =
    options.probe === false
      ? { probeSetMs: null, probeSetWarmMs: null }
      : await runStorageProbe(api, now);

  return {
    totalKeys,
    totalBytes,
    byPrefix: [...byPrefix.values()].sort((left, right) => right.bytes - left.bytes),
    nodeShardKeyCount,
    nodeShardDistinctGenerations: nodeShardGenerations.size,
    ...probe
  };
}

// Flatten the census into the flat (string|number|boolean|null) shape the incident log
// stores; the per-prefix breakdown rides as a compact JSON string in one field.
export function storageCensusIncidentDetail(result: StorageCensusResult): IncidentLogDetail {
  const detail: IncidentLogDetail = {
    totalKeys: result.totalKeys,
    totalBytes: result.totalBytes,
    nodeShardKeyCount: result.nodeShardKeyCount,
    nodeShardDistinctGenerations: result.nodeShardDistinctGenerations,
    probeSetMs: result.probeSetMs,
    probeSetWarmMs: result.probeSetWarmMs,
    byPrefix: JSON.stringify(
      result.byPrefix.map((entry) => [entry.prefix, entry.keyCount, entry.bytes])
    )
  };
  if (result.probeError !== undefined) {
    detail.probeError = result.probeError;
  }
  return detail;
}

async function runStorageProbe(
  api: WebExtensionBrowser,
  now: () => number
): Promise<{ probeSetMs: number | null; probeSetWarmMs: number | null; probeError?: string }> {
  const payload = { version: 1, at: now(), pad: "x".repeat(PROBE_PAYLOAD_BYTES) };
  try {
    const coldStart = monotonicMs();
    await api.storage.local.set({ [STORAGE_PROBE_KEY]: payload });
    const probeSetMs = Math.round(monotonicMs() - coldStart);

    const warmStart = monotonicMs();
    await api.storage.local.set({ [STORAGE_PROBE_KEY]: { ...payload, at: now() } });
    const probeSetWarmMs = Math.round(monotonicMs() - warmStart);

    // A failed remove leaves one harmless ~1 KB key that no loader/migration filter matches;
    // the next census overwrites and re-removes it.
    await api.storage.local.remove(STORAGE_PROBE_KEY).catch(() => undefined);
    return { probeSetMs, probeSetWarmMs };
  } catch (error) {
    await api.storage.local.remove(STORAGE_PROBE_KEY).catch(() => undefined);
    return {
      probeSetMs: null,
      probeSetWarmMs: null,
      probeError: error instanceof Error ? error.message : String(error)
    };
  }
}

function censusPrefix(key: string): string {
  for (const prefix of CENSUS_PREFIXES) {
    if (key === prefix || key.startsWith(prefix)) {
      return prefix;
    }
  }
  return "other";
}

function approximateValueBytes(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function monotonicMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
