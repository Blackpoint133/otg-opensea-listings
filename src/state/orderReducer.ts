import type { NormalizedOrderEvent, NormalizedTransferEvent, OrderReducerResult, OrderState, OrderStatus } from "./types.js";
import { compareEventVersions } from "./normalizers.js";

const terminal = new Set<OrderStatus>(["sold", "cancelled", "invalidated"]);
const terminalPriority: Record<OrderStatus, number> = { sold: 3, cancelled: 3, invalidated: 2, expired: 1, stale: 1, active: 0, unknown: 0 };

function timestamp(value: string | null): number | null { if (!value) return null; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
function newer(a: string | null, b: string | null): boolean { const aa = timestamp(a); const bb = timestamp(b); return aa !== null && (bb === null || aa > bb); }
function older(a: string | null, b: string | null): boolean { const aa = timestamp(a); const bb = timestamp(b); return aa !== null && bb !== null && aa < bb; }
function olderOrderEvent(event: NormalizedOrderEvent, current: OrderState): boolean { if (older(event.eventTimestamp, current.lastOrderEventTimestamp)) return true; const aa = timestamp(event.eventTimestamp); const bb = timestamp(current.lastOrderEventTimestamp); return aa !== null && bb !== null && aa === bb && compareEventVersions(event.eventVersion, current.lastOrderEventVersion) === -1; }
function olderTransferEvent(event: NormalizedTransferEvent, current: OrderState): boolean { if (older(event.eventTimestamp, current.lastNftEventTimestamp)) return true; const aa = timestamp(event.eventTimestamp); const bb = timestamp(current.lastNftEventTimestamp); return aa !== null && bb !== null && aa === bb && compareEventVersions(event.eventVersion, current.lastNftEventVersion) === -1; }
function itemMerge(oldItem: OrderState["item"], next: OrderState["item"]): OrderState["item"] { return { name: next.name ?? oldItem.name, imageUrl: next.imageUrl ?? oldItem.imageUrl, permalink: next.permalink ?? oldItem.permalink }; }
function makeBase(event: NormalizedOrderEvent, now: string, status: OrderStatus, active: boolean, needs: boolean, reason: string | null): OrderState | null {
  if (!event.orderHash || !event.nft) return null;
  return { orderHash: event.orderHash, nft: event.nft, collectionSlug: "off-the-grid", seller: event.seller, price: event.price, listingStartAt: event.listingStartAt, expirationAt: event.expirationAt, status, isActive: active, needsReconciliation: needs, reconciliationReason: reason, lastOrderEventType: event.eventType, lastOrderEventTimestamp: event.eventTimestamp, lastOrderEventVersion: event.eventVersion, lastNftEventTimestamp: null, lastNftEventVersion: null, lastTransferTransactionHash: null, item: event.item, source: "stream", lastStreamReceivedAt: event.receivedAt, lastReconciledAt: null, createdAt: now, updatedAt: now, rawLastEvent: event.rawPayload };
}
function result(state: OrderState | null, applyResult: string, ignored = false, reason: string | null = null, requiresReconciliation = false): OrderReducerResult { return { state, applyResult, ignored, reason, requiresReconciliation }; }
function mergeEvent(current: OrderState, event: NormalizedOrderEvent, now: string, status: OrderStatus, active: boolean, needs = current.needsReconciliation, reason = current.reconciliationReason): OrderState { return { ...current, nft: event.nft ?? current.nft, seller: event.seller ?? current.seller, price: event.price ?? current.price, listingStartAt: event.listingStartAt ?? current.listingStartAt, expirationAt: event.expirationAt ?? current.expirationAt, status, isActive: active, needsReconciliation: needs, reconciliationReason: reason, lastOrderEventType: event.eventType, lastOrderEventTimestamp: event.eventTimestamp ?? current.lastOrderEventTimestamp, lastOrderEventVersion: event.eventVersion ?? current.lastOrderEventVersion, item: itemMerge(current.item, event.item), lastStreamReceivedAt: event.receivedAt, updatedAt: now, rawLastEvent: event.rawPayload }; }

export function reduceOrderState(current: OrderState | null, event: NormalizedOrderEvent, now: string): OrderReducerResult {
  if (event.eventType === "order_revalidate") {
    const state = current ? { ...current, needsReconciliation: true, reconciliationReason: "order_revalidate_unverified", isActive: false, updatedAt: now } : null;
    return result(state, "journal_only_revalidate", true, "order_revalidate_unverified", true);
  }
  if (event.eventType === "item_listed") {
    if (!current) {
      const complete = Boolean(event.orderHash && event.nft && event.seller && event.price && event.expirationAt && event.eventTimestamp);
      return result(makeBase(event, now, complete ? "active" : "unknown", complete, !complete || event.mappingSuspicious, complete ? null : "listing_missing_critical_fields"), complete ? "inserted_active" : "inserted_unknown", false, complete ? null : "listing_missing_critical_fields", !complete || event.mappingSuspicious);
    }
    if (terminal.has(current.status)) return result(current, "ignored_terminal_listing", true, "terminal_state_not_reactivated", current.needsReconciliation);
    if (olderOrderEvent(event, current)) return result(current, "ignored_older_event", true, "older_business_timestamp", false);
    const complete = Boolean(event.seller ?? current.seller) && Boolean(event.price ?? current.price) && Boolean(event.expirationAt ?? current.expirationAt);
    return result(mergeEvent(current, event, now, complete ? "active" : "unknown", complete && !event.mappingSuspicious, !complete || event.mappingSuspicious, !complete ? "listing_missing_critical_fields" : event.mappingSuspicious ? event.mappingIssues.join(",") : null), "updated_listing", false, null, !complete || event.mappingSuspicious);
  }
  if (!current && event.eventType === "order_invalidate") {
    const tombstone = makeBase(event, now, "invalidated", false, true, "invalidate_without_prior_listing");
    return result(tombstone, tombstone ? "inserted_invalidation_tombstone" : "ignored_invalid_invalidation", !tombstone, tombstone ? null : "missing_order_or_nft", true);
  }
  if (!current) return result(null, "ignored_missing_order", true, "missing_prior_order", true);
  if (event.eventType === "order_invalidate" && terminalPriority[current.status] >= 3) return result(current, "preserved_specific_terminal", true, "specific_terminal_precedes_invalidation", false);
  if (event.eventType !== "order_invalidate" && (current.status === "sold" || current.status === "cancelled")) {
    const incomingStatus = event.eventType === "item_sold" ? "sold" : "cancelled";
    if (current.status !== incomingStatus) return result({ ...current, needsReconciliation: true, reconciliationReason: "terminal_event_conflict", updatedAt: now }, "terminal_conflict", true, "terminal_event_conflict", true);
  }
  if (olderOrderEvent(event, current) && !(event.eventType === "item_sold" && current.status === "invalidated")) return result(current, "ignored_older_event", true, "older_business_timestamp", false);
  if (event.eventType === "item_cancelled") return result(mergeEvent(current, event, now, "cancelled", false), "applied_cancelled");
  if (event.eventType === "item_sold") return result(mergeEvent(current, event, now, "sold", false), "applied_sold");
  return result(mergeEvent(current, event, now, "invalidated", false, true, "order_invalidated"), "applied_invalidated", false, null, true);
}

export function expireOrderState(current: OrderState, now: string): OrderReducerResult {
  if (current.status !== "active" || !current.isActive || !current.expirationAt || timestamp(current.expirationAt) === null || timestamp(current.expirationAt)! > timestamp(now)!) return result(current, "expiration_not_due", true, null, false);
  return result({ ...current, status: "expired", isActive: false, updatedAt: now }, "expired_order");
}

export function applyTransferToOrder(current: OrderState, event: NormalizedTransferEvent, now: string): OrderReducerResult {
  if (!current || !event.nft || current.nft.nftId !== event.nft.nftId) return result(current, "transfer_not_for_order", true, "nft_mismatch", false);
  if (terminal.has(current.status)) return result(current, "preserved_terminal_on_transfer", true, "terminal_state_preserved", false);
  if (olderTransferEvent(event, current)) return result(current, "ignored_older_transfer", true, "older_nft_event", false);
  return result({ ...current, isActive: false, needsReconciliation: true, reconciliationReason: "transfer_observed", lastNftEventTimestamp: event.eventTimestamp, lastNftEventVersion: event.eventVersion, lastTransferTransactionHash: event.transactionHash, updatedAt: now }, "suppressed_pending_transfer_reconciliation", false, null, true);
}

export function isVisibleLiveListing(state: OrderState, now: string): boolean { return state.status === "active" && state.isActive && !state.needsReconciliation && state.expirationAt !== null && timestamp(state.expirationAt) !== null && timestamp(state.expirationAt)! > timestamp(now)!; }
