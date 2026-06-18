export type GeneratedTraceConfig = {
  baseSeed: number;
  seedCount: number;
  seeds: number[];
  soak: boolean;
  steps: number;
};

export function generatedTraceConfig(options: {
  defaultSeedCount: number;
  defaultSteps: number;
  soakSeedCount?: number;
  soakSteps?: number;
}): GeneratedTraceConfig {
  const soak = process.env.GENERATED_TRACE_SOAK === "1";
  const baseSeed = positiveIntegerEnv("GENERATED_TRACE_BASE_SEED") ?? 1;
  const seedCount =
    positiveIntegerEnv("GENERATED_TRACE_SEED_COUNT") ??
    (soak ? (options.soakSeedCount ?? options.defaultSeedCount) : options.defaultSeedCount);
  const steps =
    positiveIntegerEnv("GENERATED_TRACE_STEPS") ??
    (soak ? (options.soakSteps ?? options.defaultSteps) : options.defaultSteps);

  return {
    baseSeed,
    seedCount,
    seeds: Array.from({ length: seedCount }, (_, index) => baseSeed + index),
    soak,
    steps
  };
}

export function generatedTraceTimeoutMs(defaultTimeoutMs: number, soakTimeoutMs: number): number {
  return process.env.GENERATED_TRACE_SOAK === "1" ? soakTimeoutMs : defaultTimeoutMs;
}

function positiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
