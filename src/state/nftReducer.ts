import type { NormalizedTransferEvent, NftReducerResult, NftState } from "./types.js";
import { compareEventVersions } from "./normalizers.js";

function ts(value: string | null): number | null { if (!value) return null; const n = Date.parse(value); return Number.isFinite(n) ? n : null; }
function merge(oldValue: string | null, newValue: string | null): string | null { return newValue ?? oldValue; }

export function reduceNftState(current: NftState | null, event: NormalizedTransferEvent, now: string): NftReducerResult {
  if (!event.nft) return { state: current, applyResult: "ignored_malformed_transfer", ignored: true, reason: "malformed_nft_id" };
  if (current && ts(event.eventTimestamp) !== null && ts(current.lastNftEventTimestamp) !== null) {
    const incoming = ts(event.eventTimestamp)!;
    const existing = ts(current.lastNftEventTimestamp)!;
    if (incoming < existing || (incoming === existing && compareEventVersions(event.eventVersion, current.lastNftEventVersion) === -1)) return { state: current, applyResult: "ignored_older_transfer", ignored: true, reason: "older_nft_event" };
  }
  const state: NftState = { identity: event.nft, collectionSlug: "off-the-grid", currentOwnerAddress: event.to, lastTransferFromAddress: event.from, lastTransferToAddress: event.to, lastTransferTransactionHash: event.transactionHash, lastTransferAt: event.transactionTimestamp ?? event.eventTimestamp, lastNftEventTimestamp: event.eventTimestamp, lastNftEventVersion: event.eventVersion, item: { name: merge(current?.item.name ?? null, event.item.name), imageUrl: merge(current?.item.imageUrl ?? null, event.item.imageUrl), permalink: merge(current?.item.permalink ?? null, event.item.permalink) }, metadataUpdatedAt: current?.metadataUpdatedAt ?? null, createdAt: current?.createdAt ?? now, updatedAt: now };
  return { state, applyResult: current ? "updated_nft_transfer" : "inserted_nft_transfer", ignored: false, reason: null };
}
