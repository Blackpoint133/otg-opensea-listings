export interface LiveWriterConfig {
  liveWritesEnabled: boolean;
  explicitWriterMode: boolean;
  maxConcurrency: number;
}

export function parseLiveWritesEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

export function loadLiveWriterConfig(env: NodeJS.ProcessEnv = process.env, explicitWriterMode = false): LiveWriterConfig {
  return {
    liveWritesEnabled: parseLiveWritesEnabled(env.OPENSEA_V2_LIVE_WRITES_ENABLED),
    explicitWriterMode,
    maxConcurrency: 1
  };
}

export function assertLiveWriterCanStart(config: LiveWriterConfig): void {
  if (!config.explicitWriterMode) throw new Error("live writer explicit mode is required");
  if (!config.liveWritesEnabled) throw new Error("OPENSEA_V2_LIVE_WRITES_ENABLED must be explicitly enabled");
  if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1) throw new Error("writer maxConcurrency must be a positive integer");
}
