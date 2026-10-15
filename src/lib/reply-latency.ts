/** No single chat reply may take longer than this. */
export const MAX_REPLY_MS = 180_000;
/** The average over a set of replies may not exceed this. */
export const MAX_AVG_REPLY_MS = 120_000;

export function summarizeLatencies(samplesMs: number[]) {
  if (samplesMs.length === 0) throw new Error("No latency samples to summarize");
  for (const ms of samplesMs) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`Invalid latency sample: ${ms}`);
    }
  }
  const total = samplesMs.reduce((sum, ms) => sum + ms, 0);
  return {
    count: samplesMs.length,
    maxMs: Math.max(...samplesMs),
    avgMs: total / samplesMs.length,
  };
}

/** Throws if any reply took over MAX_REPLY_MS or the average is over MAX_AVG_REPLY_MS. */
export function assertReplyLatency(samplesMs: number[]) {
  const summary = summarizeLatencies(samplesMs);
  if (summary.maxMs > MAX_REPLY_MS) {
    throw new Error(
      `Slowest reply took ${summary.maxMs} ms, over the ${MAX_REPLY_MS} ms limit`,
    );
  }
  if (summary.avgMs > MAX_AVG_REPLY_MS) {
    throw new Error(
      `Average reply took ${summary.avgMs} ms, over the ${MAX_AVG_REPLY_MS} ms limit`,
    );
  }
  return summary;
}
