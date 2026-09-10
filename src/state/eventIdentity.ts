import { canonicalJson, sha256 } from "./normalizers.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent } from "./types.js";

export function payloadHash(rawPayload: unknown): string { return sha256(canonicalJson(rawPayload)); }

function identityKey(prefix: string, value: unknown): string {
  return `${prefix}:v1:${sha256(canonicalJson(value))}`;
}

export function orderDedupeKey(event: NormalizedOrderEvent): string {
  if (event.orderHash !== null && event.nft !== null && event.eventTimestamp !== null && event.eventVersion !== null) {
    return identityKey("order", {
      schema: "opensea-listings-dedupe",
      version: 1,
      family: "order",
      components: {
        eventType: event.eventType,
        chain: event.nft.chain,
        contractAddress: event.nft.contractAddress,
        orderHash: event.orderHash,
        eventTimestamp: event.eventTimestamp,
        eventVersion: event.eventVersion
      }
    });
  }
  return identityKey("order-fallback", {
    schema: "opensea-listings-dedupe",
    version: 1,
    family: "order-fallback",
    eventType: event.eventType,
    payloadHash: payloadHash(event.rawPayload)
  });
}

export function transferDedupeKey(event: NormalizedTransferEvent): string {
  if (event.nft !== null && event.transactionHash !== null) {
    return identityKey("transfer", {
      schema: "opensea-listings-dedupe",
      version: 1,
      family: "transfer",
      components: {
        eventType: event.eventType,
        chain: event.nft.chain,
        contractAddress: event.nft.contractAddress,
        nftId: event.nft.nftId,
        transactionHash: event.transactionHash
      }
    });
  }
  return identityKey("transfer-fallback", {
    schema: "opensea-listings-dedupe",
    version: 1,
    family: "transfer-fallback",
    payloadHash: payloadHash(event.rawPayload)
  });
}
