import { createHash } from "node:crypto";
import { parseNftId } from "../eventTypes.js";
import type { EventVersion, NormalizedItem, NormalizedNftIdentity, NormalizedOrderEvent, NormalizedPrice, NormalizedTransferEvent, OrderEventType } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export function parseNftIdentity(value: unknown): NormalizedNftIdentity | null {
  const parsed = parseNftId(value);
  if (!parsed.valid || typeof value !== "string" || parsed.chain === null || parsed.contract_address === null || parsed.token_id_text === null) return null;
  return { nftId: value, chain: parsed.chain, contractAddress: parsed.contract_address.toLowerCase(), tokenId: parsed.token_id_text };
}

export function normalizeDecimal(raw: unknown, decimals: unknown): string | null {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return null;
  const digits = raw.replace(/^0+(?=\d)/, "") || "0";
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const integerPart = padded.slice(0, -decimals);
  const fractionPart = padded.slice(-decimals).replace(/0+$/, "");
  return `${integerPart}.${fractionPart || "0"}`;
}

export function normalizePrice(payload: any, rawField: "base_price" | "sale_price" = "base_price"): NormalizedPrice | null {
  const raw = payload?.[rawField];
  const token = payload?.payment_token;
  const normalized = normalizeDecimal(raw, token?.decimals);
  if (typeof raw !== "string" || normalized === null) return null;
  return { raw, normalizedDecimalString: normalized, tokenAddress: typeof token?.address === "string" ? token.address.toLowerCase() : null, symbol: typeof token?.symbol === "string" ? token.symbol : null, decimals: typeof token?.decimals === "number" ? token.decimals : null };
}

function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
const PG_BIGINT_MAX = 9223372036854775807n;
const BUSINESS_TIME_MIN_MS = Date.parse("2000-01-01T00:00:00.000Z");
const BUSINESS_TIME_MAX_MS = Date.parse("2100-01-01T00:00:00.000Z");
const BUSINESS_TIME_MIN_SECONDS = BigInt(Math.floor(BUSINESS_TIME_MIN_MS / 1000));
const BUSINESS_TIME_MAX_SECONDS = BigInt(Math.floor(BUSINESS_TIME_MAX_MS / 1000));
const BUSINESS_TIME_MIN_MILLISECONDS = BigInt(BUSINESS_TIME_MIN_MS);
const BUSINESS_TIME_MAX_MILLISECONDS = BigInt(BUSINESS_TIME_MAX_MS);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

function isoFromMilliseconds(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < BUSINESS_TIME_MIN_MS || value > BUSINESS_TIME_MAX_MS) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEpochDecimal(value: bigint): string | null {
  if (value >= BUSINESS_TIME_MIN_SECONDS && value <= BUSINESS_TIME_MAX_SECONDS) return isoFromMilliseconds(Number(value) * 1000);
  if (value >= BUSINESS_TIME_MIN_MILLISECONDS && value <= BUSINESS_TIME_MAX_MILLISECONDS) return isoFromMilliseconds(Number(value));
  return null;
}

export function normalizeBusinessTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return normalizeEpochDecimal(BigInt(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (DECIMAL_INTEGER.test(trimmed)) return normalizeEpochDecimal(BigInt(trimmed));
  if (!ISO_TIMESTAMP.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? isoFromMilliseconds(parsed) : null;
}

export function normalizeBusinessSecond(value: unknown): string | null {
  const normalized = normalizeBusinessTimestamp(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(Math.floor(parsed / 1000) * 1000).toISOString();
}

export function normalizeEventVersion(value: unknown): EventVersion {
  if (typeof value === "bigint") return value >= 0n && value <= PG_BIGINT_MAX ? value.toString() : null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= PG_BIGINT_MAX ? parsed.toString() : null;
}

export function compareEventVersions(a: EventVersion, b: EventVersion): number | null {
  if (a === null || b === null) return null;
  const normalizedA = normalizeEventVersion(a);
  const normalizedB = normalizeEventVersion(b);
  if (normalizedA === null || normalizedB === null) return null;
  const aa = BigInt(normalizedA);
  const bb = BigInt(normalizedB);
  return aa === bb ? 0 : aa > bb ? 1 : -1;
}

function versionIssue(value: unknown): string[] {
  return value === undefined || normalizeEventVersion(value) !== null ? [] : ["event_version_invalid_or_unsafe"];
}
function itemFrom(payload: any): NormalizedItem {
  const item = payload?.item ?? {};
  const metadata = item.metadata ?? {};
  return { name: text(metadata.name), imageUrl: text(metadata.image_url), permalink: text(item.permalink) };
}

function normalizedEventType(value: unknown): OrderEventType | null {
  return value === "item_listed" || value === "item_cancelled" || value === "item_sold" || value === "order_invalidate" || value === "order_revalidate" ? value : null;
}

export function normalizeOrderEvent(rawEvent: any, receivedAt: string): NormalizedOrderEvent | null {
  const eventType = normalizedEventType(rawEvent?.event_type);
  if (!eventType) return null;
  const payload = rawEvent?.payload ?? {};
  const nft = parseNftIdentity(payload.item?.nft_id);
  const offer = payload.protocol_data?.parameters?.offer?.[0];
  const issues: string[] = [];
  if (eventType === "item_listed" && nft && typeof offer?.token === "string" && offer.token.toLowerCase() !== nft.contractAddress) issues.push("nft_contract_disagrees_with_protocol_offer");
  if (eventType === "item_listed" && nft && offer?.identifierOrCriteria !== undefined && String(offer.identifierOrCriteria) !== nft.tokenId) issues.push("nft_token_disagrees_with_protocol_offer");
  const maker = text(payload.maker?.address);
  const offerer = text(payload.protocol_data?.parameters?.offerer);
  if (maker && offerer && maker.toLowerCase() !== offerer.toLowerCase()) issues.push("maker_disagrees_with_protocol_offerer");
  issues.push(...versionIssue(rawEvent?.version));
  const price = eventType === "item_sold" ? normalizePrice(payload, "sale_price") : normalizePrice(payload, "base_price");
  return {
    eventType,
    eventTimestamp: normalizeBusinessTimestamp(payload.event_timestamp),
    eventVersion: normalizeEventVersion(rawEvent?.version),
    orderHash: text(payload.order_hash),
    nft,
    seller: maker,
    buyerCandidate: text(payload.taker?.address),
    price,
    listingStartAt: normalizeBusinessTimestamp(payload.listing_date),
    expirationAt: normalizeBusinessTimestamp(payload.expiration_date),
    item: itemFrom(payload),
    transactionHash: text(payload.transaction?.hash ?? payload.transaction_hash),
    receivedAt,
    rawPayload: rawEvent,
    mappingSuspicious: issues.length > 0,
    mappingIssues: issues
  };
}

export function normalizeTransferEvent(rawEvent: any, receivedAt: string): NormalizedTransferEvent | null {
  if (rawEvent?.event_type !== "item_transferred") return null;
  const payload = rawEvent?.payload ?? {};
  return { eventType: "item_transferred", nft: parseNftIdentity(payload.item?.nft_id), from: text(payload.from_account?.address), to: text(payload.to_account?.address), transactionHash: text(payload.transaction?.hash), transactionTimestamp: normalizeBusinessTimestamp(payload.transaction?.timestamp), eventTimestamp: normalizeBusinessTimestamp(payload.event_timestamp), eventVersion: normalizeEventVersion(rawEvent?.version), receivedAt, rawPayload: rawEvent, item: itemFrom(payload) };
}

export function normalizeUnknownRevalidate(rawEvent: any, receivedAt: string): NormalizedOrderEvent | null {
  if (rawEvent?.event_type !== "order_revalidate") return null;
  const payload = rawEvent?.payload ?? {};
  return { eventType: "order_revalidate", eventTimestamp: normalizeBusinessTimestamp(payload.event_timestamp), eventVersion: normalizeEventVersion(rawEvent?.version), orderHash: text(payload.order_hash), nft: parseNftIdentity(payload.item?.nft_id), seller: null, buyerCandidate: null, price: null, listingStartAt: null, expirationAt: null, item: itemFrom(payload), transactionHash: null, receivedAt, rawPayload: rawEvent, mappingSuspicious: true, mappingIssues: ["order_revalidate_payload_unverified", ...versionIssue(rawEvent?.version)] };
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function canonicalJson(value: unknown): string { return canonical(value); }
export function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function isZeroAddress(value: string | null): boolean { return value?.toLowerCase() === ZERO; }
