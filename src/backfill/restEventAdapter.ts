import { normalizeBusinessTimestamp, normalizeEventVersion } from "../state/normalizers.js";
import {
  REST_BACKFILL_CHAIN,
  REST_BACKFILL_COLLECTION_SLUG,
  REST_BACKFILL_CONTRACT_ADDRESS,
  SUPPORTED_REST_EVENT_TYPES,
  UNSUPPORTED_REST_EVENT_TYPES,
  type DurableBackfillEventType,
  type RestEventAdaptResult,
  type SupportedRestEventType
} from "./types.js";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberText(value: unknown): string | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function nested(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const source = record(current);
    if (!source) return undefined;
    current = source[key];
  }
  return current;
}

function firstText(source: unknown, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    const value = text(nested(source, path));
    if (value) return value;
  }
  return null;
}

function firstNumberText(source: unknown, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    const value = numberText(nested(source, path));
    if (value) return value;
  }
  return null;
}

function optionalNumberText(source: unknown, paths: readonly (readonly string[])[]): { present: boolean; value: string | null } {
  for (const path of paths) {
    const raw = nested(source, path);
    if (raw === undefined) continue;
    return { present: true, value: numberText(raw) };
  }
  return { present: false, value: null };
}

function validateAddress(value: string | null, field: string): string | { error: string } {
  if (value && ADDRESS.test(value)) return value.toLowerCase();
  return { error: `${field}_missing_or_invalid` };
}

function validateHash(value: string | null, field: string): string | { error: string } {
  if (value && HASH.test(value)) return value.toLowerCase();
  return { error: `${field}_missing_or_invalid` };
}

function errorOrValue(value: string | { error: string }): string {
  if (typeof value === "string") return value;
  throw new Error(value.error);
}

function validateSourceChain(raw: unknown): void {
  const chain = text(nested(raw, ["chain"]));
  if (chain !== null && chain.toLowerCase() !== REST_BACKFILL_CHAIN) throw new Error("chain_outside_pinned_collection");
}

function requireSourceChain(raw: unknown): void {
  const chain = text(nested(raw, ["chain"]));
  if (chain === null) throw new Error("chain_missing_or_invalid");
  if (chain.toLowerCase() !== REST_BACKFILL_CHAIN) throw new Error("chain_outside_pinned_collection");
}

function restEventType(raw: unknown): string {
  return text(nested(raw, ["event_type"])) ?? text(nested(raw, ["eventType"])) ?? "unknown";
}

export function restCoverageForEventType(value: string): "supported" | "unsupported" {
  return (SUPPORTED_REST_EVENT_TYPES as readonly string[]).includes(value) ? "supported" : "unsupported";
}

function durableTypeFor(value: SupportedRestEventType): DurableBackfillEventType {
  if (value === "listing") return "item_listed";
  if (value === "sale") return "item_sold";
  return "item_transferred";
}

function extractCommon(raw: unknown): {
  nftId: string;
  tokenId: string;
  version: string;
  eventTimestamp: string;
  item: { nft_id: string; metadata: { name: string | null; image_url: string | null }; permalink: string | null };
} {
  const tokenId = firstNumberText(raw, [["nft", "identifier"], ["nft", "token_id"], ["asset", "identifier"], ["asset", "token_id"], ["item", "token_id"], ["token_id"]]);
  if (!tokenId) throw new Error("token_id_missing_or_invalid");
  const contractCandidate = firstText(raw, [["nft", "contract"], ["nft", "contract_address"], ["nft", "contract", "address"], ["asset", "contract"], ["asset", "contract_address"], ["asset", "contract", "address"], ["contract_address"]]) ?? REST_BACKFILL_CONTRACT_ADDRESS;
  const contract = errorOrValue(validateAddress(contractCandidate, "contract_address"));
  if (contract !== REST_BACKFILL_CONTRACT_ADDRESS) throw new Error("contract_address_outside_pinned_collection");
  const timestampRaw = firstText(raw, [["event_timestamp"], ["eventTimestamp"], ["created_date"], ["created_at"], ["timestamp"]]) ?? nested(raw, ["event_timestamp"]);
  const eventTimestamp = normalizeBusinessTimestamp(timestampRaw);
  if (!eventTimestamp) throw new Error("event_timestamp_missing_or_invalid");
  const version = normalizeEventVersion(firstNumberText(raw, [["version"], ["event_version"], ["eventVersion"]]));
  if (!version) throw new Error("event_version_missing_or_invalid");
  const nftId = `${REST_BACKFILL_CHAIN}/${REST_BACKFILL_CONTRACT_ADDRESS}/${tokenId}`;
  return {
    nftId,
    tokenId,
    version,
    eventTimestamp,
    item: {
      nft_id: nftId,
      metadata: {
        name: firstText(raw, [["nft", "name"], ["asset", "name"], ["item", "metadata", "name"]]),
        image_url: firstText(raw, [["nft", "image_url"], ["asset", "image_url"], ["item", "metadata", "image_url"]])
      },
      permalink: firstText(raw, [["nft", "permalink"], ["asset", "permalink"], ["item", "permalink"]])
    }
  };
}

function extractTransferCommon(raw: unknown): {
  nftId: string;
  tokenId: string;
  version: string | null;
  eventTimestamp: string;
  item: { nft_id: string; metadata: { name: string | null; image_url: string | null }; permalink: string | null };
} {
  requireSourceChain(raw);
  const tokenId = firstNumberText(raw, [["nft", "identifier"], ["nft", "token_id"], ["asset", "identifier"], ["asset", "token_id"], ["item", "token_id"], ["token_id"]]);
  if (!tokenId) throw new Error("token_id_missing_or_invalid");
  const contractCandidate = firstText(raw, [["nft", "contract"], ["nft", "contract_address"], ["nft", "contract", "address"], ["asset", "contract"], ["asset", "contract_address"], ["asset", "contract", "address"], ["contract_address"]]);
  if (!contractCandidate) throw new Error("contract_address_missing_or_invalid");
  const contract = errorOrValue(validateAddress(contractCandidate, "contract_address"));
  if (contract !== REST_BACKFILL_CONTRACT_ADDRESS) throw new Error("contract_address_outside_pinned_collection");
  const timestampRaw = firstText(raw, [["event_timestamp"], ["eventTimestamp"], ["created_date"], ["created_at"], ["timestamp"]]) ?? nested(raw, ["event_timestamp"]);
  const eventTimestamp = normalizeBusinessTimestamp(timestampRaw);
  if (!eventTimestamp) throw new Error("event_timestamp_missing_or_invalid");
  const versionCandidate = optionalNumberText(raw, [["version"], ["event_version"], ["eventVersion"]]);
  if (versionCandidate.present && versionCandidate.value === null) throw new Error("event_version_missing_or_invalid");
  const version = versionCandidate.value === null ? null : normalizeEventVersion(versionCandidate.value);
  if (versionCandidate.present && version === null) throw new Error("event_version_missing_or_invalid");
  const nftId = `${REST_BACKFILL_CHAIN}/${REST_BACKFILL_CONTRACT_ADDRESS}/${tokenId}`;
  return {
    nftId,
    tokenId,
    version,
    eventTimestamp,
    item: {
      nft_id: nftId,
      metadata: {
        name: firstText(raw, [["nft", "name"], ["asset", "name"], ["item", "metadata", "name"]]),
        image_url: firstText(raw, [["nft", "image_url"], ["asset", "image_url"], ["item", "metadata", "image_url"]])
      },
      permalink: firstText(raw, [["nft", "permalink"], ["asset", "permalink"], ["item", "permalink"]])
    }
  };
}

function sourceEvidence(raw: unknown): Record<string, unknown> {
  return {
    source: "opensea_rest_events_backfill",
    endpoint: "collection_events",
    collection_slug: REST_BACKFILL_COLLECTION_SLUG,
    chain: REST_BACKFILL_CHAIN,
    contract_address: REST_BACKFILL_CONTRACT_ADDRESS,
    raw_event: raw
  };
}

function adaptOrder(raw: unknown, restType: "listing" | "sale"): unknown {
  const common = extractCommon(raw);
  const orderHash = errorOrValue(validateHash(firstText(raw, [["order_hash"], ["orderHash"], ["order", "hash"], ["protocol_data", "order_hash"]]), "order_hash"));
  const seller = validateAddress(firstText(raw, [["seller"], ["seller", "address"], ["maker"], ["maker", "address"], ["maker_address"]]), "seller_address");
  if (typeof seller !== "string") throw new Error(seller.error);
  const buyer = restType === "sale" ? validateAddress(firstText(raw, [["buyer"], ["buyer", "address"], ["taker"], ["taker", "address"], ["taker_address"]]), "buyer_address") : null;
  if (buyer !== null && typeof buyer !== "string") throw new Error(buyer.error);
  const price = firstNumberText(raw, [["price"], ["base_price"], ["payment", "quantity"], ["total_price"], ["sale_price"]]);
  if (!price) throw new Error("price_missing_or_invalid");
  const paymentToken = record(nested(raw, ["payment_token"])) ?? record(nested(raw, ["payment"]));
  const decimals = nested(paymentToken, ["decimals"]);
  const decimalsNumber = typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  return {
    event_type: durableTypeFor(restType),
    version: common.version,
    payload: {
      event_timestamp: common.eventTimestamp,
      order_hash: orderHash,
      item: common.item,
      maker: { address: seller },
      taker: buyer ? { address: buyer } : undefined,
      base_price: restType === "listing" ? price : undefined,
      sale_price: restType === "sale" ? price : undefined,
      payment_token: {
        address: text(nested(paymentToken, ["address"])),
        symbol: text(nested(paymentToken, ["symbol"])),
        decimals: decimalsNumber
      },
      listing_date: normalizeBusinessTimestamp(firstText(raw, [["listing_date"], ["start_date"], ["created_date"], ["created_at"]])) ?? common.eventTimestamp,
      expiration_date: normalizeBusinessTimestamp(firstText(raw, [["expiration_date"], ["expiration"]])),
      transaction: restType === "sale" ? { hash: text(nested(raw, ["transaction", "hash"])) ?? text(nested(raw, ["transaction_hash"])) } : undefined,
      collection: { slug: REST_BACKFILL_COLLECTION_SLUG },
      rest_backfill_source: sourceEvidence(raw)
    }
  };
}

function adaptTransfer(raw: unknown): unknown {
  const transferType = text(nested(raw, ["transfer_type"]));
  if (transferType !== "transfer" && transferType !== "mint") throw new Error("unsupported_transfer_type");
  const common = extractTransferCommon(raw);
  const txHash = errorOrValue(validateHash(firstText(raw, [["transaction", "hash"], ["transaction_hash"], ["transaction"]]), "transaction_hash"));
  const from = validateAddress(firstText(raw, [["from_account", "address"], ["from", "address"], ["from_address"], ["from"]]), "from_address");
  const to = validateAddress(firstText(raw, [["to_account", "address"], ["to", "address"], ["to_address"], ["to"]]), "to_address");
  if (typeof from !== "string") throw new Error(from.error);
  if (typeof to !== "string") throw new Error(to.error);
  if (transferType === "mint" && from !== to) throw new Error("rest_mint_shape_unproven");
  const canonicalFrom = transferType === "mint" ? ZERO_ADDRESS : from;
  return {
    event_type: "item_transferred",
    ...(common.version !== null ? { version: common.version } : {}),
    payload: {
      event_timestamp: common.eventTimestamp,
      item: common.item,
      from_account: { address: canonicalFrom },
      to_account: { address: to },
      transaction: { hash: txHash, timestamp: normalizeBusinessTimestamp(firstText(raw, [["transaction", "timestamp"], ["transaction_timestamp"]])) ?? common.eventTimestamp },
      collection: { slug: REST_BACKFILL_COLLECTION_SLUG },
      rest_backfill_source: {
        ...sourceEvidence(raw),
        transfer_type: transferType,
        canonical_mint_from_zero_source: transferType === "mint",
        transaction_timestamp_derived_from_event_timestamp: true
      }
    }
  };
}

export function adaptRestEventToDurableIngress(raw: unknown): RestEventAdaptResult {
  const type = restEventType(raw);
  if ((UNSUPPORTED_REST_EVENT_TYPES as readonly string[]).includes(type) || restCoverageForEventType(type) === "unsupported") {
    return { outcome: "unsupported", restEventType: type, reason: `${type}_not_backfillable_by_current_rest_contract` };
  }
  try {
    const restType = type as SupportedRestEventType;
    const rawEvent = restType === "transfer" ? adaptTransfer(raw) : adaptOrder(raw, restType);
    return { outcome: "adapted", restEventType: restType, durableEventType: durableTypeFor(restType), rawEvent, eventTimestamp: ((rawEvent as any).payload.event_timestamp as string | null) ?? null };
  } catch (error) {
    return { outcome: "malformed", restEventType: type, reason: error instanceof Error ? error.message : "malformed_rest_event" };
  }
}
