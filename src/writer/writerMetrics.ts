import type { WriterMetricsSnapshot, WriterResult } from "./types.js";

export class WriterMetrics {
  private snapshotValue: WriterMetricsSnapshot = {
    events_received: 0,
    events_applied: 0,
    duplicates: 0,
    reconciliation_required: 0,
    unsupported: 0,
    normalization_failed: 0,
    errors: 0
  };

  record(result: WriterResult): void {
    this.snapshotValue.events_received += 1;
    if (result.result === "applied") this.snapshotValue.events_applied += 1;
    if (result.result === "duplicate_ignored") this.snapshotValue.duplicates += 1;
    if (result.reconciliationRequired || result.result === "journaled_reconciliation_required") this.snapshotValue.reconciliation_required += 1;
    if (result.result === "ignored_unsupported_type") this.snapshotValue.unsupported += 1;
    if (result.result === "normalization_failed") this.snapshotValue.normalization_failed += 1;
    if (result.result === "failed") this.snapshotValue.errors += 1;
  }

  snapshot(): WriterMetricsSnapshot {
    return { ...this.snapshotValue };
  }
}
