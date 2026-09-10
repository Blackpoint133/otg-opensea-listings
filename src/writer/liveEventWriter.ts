import { applyNormalizedEvent } from "../db/eventApplicationService.js";
import type { DbPool, NormalizedEventForApplication } from "../db/types.js";
import { redactString } from "../logger.js";
import { normalizeOrderEvent, normalizeTransferEvent, normalizeUnknownRevalidate } from "../state/normalizers.js";
import type { LiveWriterConfig } from "./writerConfig.js";
import { assertLiveWriterCanStart } from "./writerConfig.js";
import { WriterMetrics } from "./writerMetrics.js";
import type { EventApplicator, WriterMetricsSnapshot, WriterResult } from "./types.js";

const SUPPORTED = new Set(["item_listed", "item_cancelled", "item_sold", "item_transferred", "order_invalidate", "order_revalidate"]);

export interface LiveEventWriterOptions {
  pool: DbPool;
  config: LiveWriterConfig;
  applyEvent?: EventApplicator;
  normalizeEvent?: (rawEvent: unknown, receivedAt: string) => NormalizedEventForApplication | null;
  now?: () => string;
}

function eventTypeOf(rawEvent: unknown): string {
  const value = (rawEvent as { event_type?: unknown } | null)?.event_type;
  return typeof value === "string" ? value : "unknown";
}

export function normalizeWriterEvent(rawEvent: unknown, receivedAt: string): NormalizedEventForApplication | null {
  const eventType = eventTypeOf(rawEvent);
  if (eventType === "item_transferred") return normalizeTransferEvent(rawEvent, receivedAt);
  if (eventType === "order_revalidate") return normalizeUnknownRevalidate(rawEvent, receivedAt);
  if (eventType === "item_listed" || eventType === "item_cancelled" || eventType === "item_sold" || eventType === "order_invalidate") return normalizeOrderEvent(rawEvent, receivedAt);
  return null;
}

function emptyResult(eventType: string, result: WriterResult["result"], durationMs: number, errorMessage?: string): WriterResult {
  return {
    eventType,
    dedupeKey: null,
    result,
    applyResult: null,
    orderHash: null,
    nftId: null,
    stateChanged: false,
    reconciliationRequired: result === "normalization_failed",
    journalEventId: null,
    durationMs,
    ...(errorMessage ? { errorMessage } : {})
  };
}

function sanitizeErrorMessage(value: string): string {
  return redactString(value).replace(/\b(password|token|secret|api[_-]?key)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>");
}

export class LiveEventWriter {
  private readonly applyEvent: EventApplicator;
  private readonly normalizeEvent: (rawEvent: unknown, receivedAt: string) => NormalizedEventForApplication | null;
  private readonly now: () => string;
  private readonly metrics = new WriterMetrics();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: LiveEventWriterOptions) {
    assertLiveWriterCanStart(options.config);
    this.applyEvent = options.applyEvent ?? applyNormalizedEvent;
    this.normalizeEvent = options.normalizeEvent ?? normalizeWriterEvent;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  metricsSnapshot(): WriterMetricsSnapshot {
    return this.metrics.snapshot();
  }

  async handleEvent(rawEvent: unknown, receivedAt: string = this.now()): Promise<WriterResult> {
    if (this.closed) throw new Error("live event writer is closed");
    const task = this.handleEventInternal(rawEvent, receivedAt);
    this.inFlight.add(task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(task);
    }
  }

  private async handleEventInternal(rawEvent: unknown, receivedAt: string): Promise<WriterResult> {
    const started = Date.now();
    const eventType = eventTypeOf(rawEvent);
    if (!SUPPORTED.has(eventType)) {
      const result = emptyResult(eventType, "ignored_unsupported_type", Date.now() - started);
      this.metrics.record(result);
      return result;
    }
    const normalized = this.normalizeEvent(rawEvent, receivedAt);
    if (!normalized) {
      const result = emptyResult(eventType, "normalization_failed", Date.now() - started);
      this.metrics.record(result);
      return result;
    }
    try {
      const applied = await this.applyEvent(this.options.pool, normalized, this.now());
      const result: WriterResult = {
        eventType,
        dedupeKey: applied.dedupeKey,
        result: applied.result,
        applyResult: applied.applyResult,
        orderHash: applied.orderHash,
        nftId: applied.nftId,
        stateChanged: applied.stateChanged,
        reconciliationRequired: applied.reconciliationRequired,
        journalEventId: applied.journalEventId,
        durationMs: Date.now() - started
      };
      this.metrics.record(result);
      return result;
    } catch (error) {
      const result = emptyResult(eventType, "failed", Date.now() - started, sanitizeErrorMessage(error instanceof Error ? error.message : String(error)));
      this.metrics.record(result);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { writerResult: result });
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
    await this.options.pool.end();
  }
}
