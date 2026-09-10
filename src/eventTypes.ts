import { EventType } from "@opensea/stream-js";

export type CaptureProfile = "all" | "orders" | "transfers";

export const PROFILE_EVENT_TYPES: Record<CaptureProfile, readonly EventType[]> = {
  all: [EventType.ITEM_LISTED, EventType.ITEM_CANCELLED, EventType.ITEM_SOLD, EventType.ITEM_TRANSFERRED, EventType.ORDER_INVALIDATE, EventType.ORDER_REVALIDATE],
  orders: [EventType.ITEM_LISTED, EventType.ITEM_CANCELLED, EventType.ITEM_SOLD, EventType.ORDER_INVALIDATE, EventType.ORDER_REVALIDATE],
  transfers: [EventType.ITEM_TRANSFERRED]
};

export const SELECTED_EVENT_TYPES = PROFILE_EVENT_TYPES.all;

export function isCaptureProfile(value: string): value is CaptureProfile {
  return value === "all" || value === "orders" || value === "transfers";
}

export function eventTypesForProfile(profile: CaptureProfile): readonly EventType[] {
  return PROFILE_EVENT_TYPES[profile];
}

export function eventTypeName(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

export interface NormalizedNftId {
  valid: boolean;
  chain: string | null;
  contract_address: string | null;
  token_id_text: string | null;
}

export function parseNftId(value: unknown): NormalizedNftId {
  if (typeof value !== "string") return { valid: false, chain: null, contract_address: null, token_id_text: null };
  const match = /^([^/]+)\/([^/]+)\/([0-9]+)$/.exec(value);
  if (!match) return { valid: false, chain: null, contract_address: null, token_id_text: null };
  return { valid: true, chain: match[1], contract_address: match[2], token_id_text: match[3] };
}

export interface EventSummary {
  event_type: string;
  version?: unknown;
  event_timestamp?: unknown;
  order_hash?: unknown;
  nft_id?: unknown;
  chain?: unknown;
  contract_address?: unknown;
  token_id_text?: unknown;
  collection_slug?: unknown;
  item_name?: unknown;
  image_url?: unknown;
  permalink?: unknown;
  maker_seller_address?: unknown;
  payment_token_symbol?: unknown;
  payment_token_address?: unknown;
  payment_token_decimals?: unknown;
  base_price?: unknown;
  sale_price?: unknown;
  listing_date?: unknown;
  expiration_date?: unknown;
  from_address?: unknown;
  to_address?: unknown;
  quantity?: unknown;
  transaction_hash?: unknown;
  transaction_timestamp?: unknown;
  transfer_classification_hint?: string;
  nft_id_parse_valid?: boolean;
}

export function summarizeEvent(event: any): EventSummary {
  const payload = event?.payload ?? {};
  const item = payload.item ?? {};
  const nft = item.nft ?? {};
  const nftId = item.nft_id ?? nft.nft_id;
  const normalized = parseNftId(nftId);
  const paymentToken = payload.payment_token ?? {};
  const transaction = payload.transaction ?? {};
  const from = payload.from_account?.address;
  const to = payload.to_account?.address;
  const zero = "0x0000000000000000000000000000000000000000";
  let transferHint: string | undefined;
  if (from && from.toLowerCase() === zero) transferHint = "zero_source";
  else if (to && to.toLowerCase() === zero) transferHint = "zero_destination";
  else if (from && to) transferHint = "wallet_to_wallet";
  else if (event?.event_type === EventType.ITEM_TRANSFERRED) transferHint = "unknown";
  return {
    event_type: eventTypeName(event?.event_type ?? event?.eventType),
    version: event?.version,
    event_timestamp: payload.event_timestamp,
    order_hash: payload.order_hash,
    nft_id: nftId,
    chain: normalized.valid ? normalized.chain : payload.chain ?? nft.chain?.name,
    contract_address: normalized.contract_address,
    token_id_text: normalized.token_id_text,
    collection_slug: payload.collection?.slug,
    item_name: item.metadata?.name ?? nft.metadata?.name,
    image_url: item.metadata?.image_url ?? item.metadata?.image ?? nft.metadata?.image_url,
    permalink: item.permalink ?? nft.permalink,
    maker_seller_address: payload.maker?.address ?? payload.seller?.address ?? payload.seller,
    payment_token_symbol: paymentToken.symbol,
    payment_token_address: paymentToken.address,
    payment_token_decimals: paymentToken.decimals,
    base_price: payload.base_price,
    sale_price: payload.sale_price,
    listing_date: payload.listing_date ?? payload.created_date,
    expiration_date: payload.expiration_date,
    from_address: from,
    to_address: to,
    quantity: payload.quantity,
    transaction_hash: transaction.hash ?? payload.transaction_hash,
    transaction_timestamp: transaction.timestamp,
    transfer_classification_hint: transferHint,
    nft_id_parse_valid: typeof nftId === "string" ? normalized.valid : undefined
  };
}
