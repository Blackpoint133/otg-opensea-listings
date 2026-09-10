import { redactString } from "../logger.js";
import type { WriterResult } from "../writer/types.js";

export type SinkState = "accepting" | "draining" | "stopped" | "failed";
export type SinkStopReason = "duration_reached" | "max_events_reached" | "queue_overflow" | "writer_error" | "stream_error" | "stream_readiness_timeout" | "stream_join_error" | "signal_interrupt" | "signal_terminate" | "manual_stop";

export interface SerializedEventSinkOptions {
  queueCapacity: number;
  maxEvents: number;
  handleEvent: (event: unknown) => Promise<WriterResult>;
  onStopRequested?: (reason: SinkStopReason, fatal: boolean) => void;
}

export interface SinkSnapshot {
  state: SinkState;
  eventsReceived: number;
  eventsAccepted: number;
  eventsProcessed: number;
  eventsApplied: number;
  duplicates: number;
  reconciliationRequired: number;
  unsupported: number;
  normalizationFailed: number;
  errors: number;
  queueHighWaterMark: number;
  queueOverflowCount: number;
  maxConcurrentWriterCallsObserved: number;
  lastErrorMessage: string | null;
  stopReason: SinkStopReason | null;
}

export interface EnqueueResult {
  accepted: boolean;
  reason?: SinkStopReason | "not_accepting";
}

export class SerializedEventSink {
  private readonly queue: unknown[] = [];
  private stateValue: SinkState = "accepting";
  private processing = false;
  private inFlight = 0;
  private idleWaiters: Array<() => void> = [];
  private stopReasonValue: SinkStopReason | null = null;
  private snapshotValue: SinkSnapshot = {
    state: "accepting",
    eventsReceived: 0,
    eventsAccepted: 0,
    eventsProcessed: 0,
    eventsApplied: 0,
    duplicates: 0,
    reconciliationRequired: 0,
    unsupported: 0,
    normalizationFailed: 0,
    errors: 0,
    queueHighWaterMark: 0,
    queueOverflowCount: 0,
    maxConcurrentWriterCallsObserved: 0,
    lastErrorMessage: null,
    stopReason: null
  };

  constructor(private readonly options: SerializedEventSinkOptions) {
    if (!Number.isInteger(options.queueCapacity) || options.queueCapacity < 1) throw new Error("queueCapacity must be a positive integer");
    if (!Number.isInteger(options.maxEvents) || options.maxEvents < 1) throw new Error("maxEvents must be a positive integer");
  }

  get state(): SinkState {
    return this.stateValue;
  }

  enqueue(event: unknown): EnqueueResult {
    this.snapshotValue.eventsReceived += 1;
    if (this.stateValue !== "accepting") return { accepted: false, reason: "not_accepting" };
    if (this.snapshotValue.eventsAccepted >= this.options.maxEvents) {
      this.requestStop("max_events_reached", false);
      return { accepted: false, reason: "max_events_reached" };
    }
    if (this.queue.length >= this.options.queueCapacity) {
      this.snapshotValue.queueOverflowCount += 1;
      this.requestStop("queue_overflow", true);
      return { accepted: false, reason: "queue_overflow" };
    }
    this.queue.push(event);
    this.snapshotValue.eventsAccepted += 1;
    this.snapshotValue.queueHighWaterMark = Math.max(this.snapshotValue.queueHighWaterMark, this.queue.length);
    if (this.snapshotValue.eventsAccepted >= this.options.maxEvents) this.requestStop("max_events_reached", false);
    void this.process();
    return { accepted: true };
  }

  requestStop(reason: SinkStopReason, fatal: boolean): void {
    if (this.stateValue === "stopped" || this.stateValue === "failed") return;
    this.stopReasonValue = this.stopReasonValue ?? reason;
    this.snapshotValue.stopReason = this.stopReasonValue;
    this.stateValue = fatal ? "failed" : "draining";
    if (fatal) this.queue.length = 0;
    this.snapshotValue.state = this.stateValue;
    this.options.onStopRequested?.(reason, fatal);
    this.resolveIdleIfReady();
  }

  async drain(): Promise<void> {
    if (this.stateValue === "accepting") this.requestStop("manual_stop", false);
    if (!this.processing && this.queue.length === 0) {
      this.markStoppedIfDrained();
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot(): SinkSnapshot {
    return { ...this.snapshotValue, state: this.stateValue, stopReason: this.stopReasonValue };
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.stateValue !== "failed") {
        const event = this.queue.shift();
        this.inFlight += 1;
        this.snapshotValue.maxConcurrentWriterCallsObserved = Math.max(this.snapshotValue.maxConcurrentWriterCallsObserved, this.inFlight);
        try {
          const result = await this.options.handleEvent(event);
          this.recordResult(result);
        } catch (error) {
          this.snapshotValue.errors += 1;
          this.snapshotValue.lastErrorMessage = redactString(error instanceof Error ? error.message : String(error));
          this.requestStop("writer_error", true);
        } finally {
          this.inFlight -= 1;
        }
      }
    } finally {
      this.processing = false;
      this.markStoppedIfDrained();
      this.resolveIdleIfReady();
    }
  }

  private recordResult(result: WriterResult): void {
    this.snapshotValue.eventsProcessed += 1;
    if (result.result === "applied") this.snapshotValue.eventsApplied += 1;
    if (result.result === "duplicate_ignored") this.snapshotValue.duplicates += 1;
    if (result.reconciliationRequired || result.result === "journaled_reconciliation_required") this.snapshotValue.reconciliationRequired += 1;
    if (result.result === "ignored_unsupported_type") this.snapshotValue.unsupported += 1;
    if (result.result === "normalization_failed") this.snapshotValue.normalizationFailed += 1;
    if (result.result === "failed") this.snapshotValue.errors += 1;
  }

  private markStoppedIfDrained(): void {
    if ((this.stateValue === "draining" || this.stateValue === "failed") && this.queue.length === 0 && this.inFlight === 0 && !this.processing) {
      if (this.stateValue === "draining") this.stateValue = "stopped";
      this.snapshotValue.state = this.stateValue;
    }
  }

  private resolveIdleIfReady(): void {
    if ((this.stateValue === "stopped" || this.stateValue === "failed") && this.queue.length === 0 && this.inFlight === 0 && !this.processing) {
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}
