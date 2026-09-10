import type { NormalizedPrice, OrderState } from "../state/types.js";
import type { ActiveOrderSelector, Queryable } from "./types.js";
import { stringifyJsonb } from "./jsonb.js";

export const LISTINGS_TABLE = "public.opensea_listings_v2";

interface OrderRow {
  order_hash: string;
  nft_id: string;
  chain: string;
  contract_address: string;
  token_id: string;
  collection_slug: string;
  seller_address: string | null;
  price_raw: string | null;
  price_normalized: string | null;
  payment_token_address: string | null;
  payment_token_symbol: string | null;
  payment_token_decimals: number | null;
  listing_start_at: string | null;
  expiration_at: string | null;
  status: OrderState["status"];
  is_active: boolean;
  needs_reconciliation: boolean;
  reconciliation_reason: string | null;
  last_order_event_type: string | null;
  last_order_event_timestamp: string | null;
  last_order_event_version: string | null;
  last_nft_event_timestamp: string | null;
  last_nft_event_version: string | null;
  last_transfer_transaction_hash: string | null;
  item_name: string | null;
  image_url: string | null;
  permalink: string | null;
  source: string;
  last_stream_received_at: string | null;
  last_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
  raw_last_event: unknown;
}

function priceFrom(row: OrderRow): NormalizedPrice | null {
  if (row.price_raw === null || row.price_normalized === null) return null;
  return {
    raw: row.price_raw,
    normalizedDecimalString: row.price_normalized,
    tokenAddress: row.payment_token_address,
    symbol: row.payment_token_symbol,
    decimals: row.payment_token_decimals
  };
}

function mapOrderRow(row: OrderRow): OrderState {
  return {
    orderHash: row.order_hash,
    nft: { nftId: row.nft_id, chain: row.chain, contractAddress: row.contract_address, tokenId: row.token_id },
    collectionSlug: row.collection_slug,
    seller: row.seller_address,
    price: priceFrom(row),
    listingStartAt: row.listing_start_at,
    expirationAt: row.expiration_at,
    status: row.status,
    isActive: row.is_active,
    needsReconciliation: row.needs_reconciliation,
    reconciliationReason: row.reconciliation_reason,
    lastOrderEventType: row.last_order_event_type,
    lastOrderEventTimestamp: row.last_order_event_timestamp,
    lastOrderEventVersion: row.last_order_event_version,
    lastNftEventTimestamp: row.last_nft_event_timestamp,
    lastNftEventVersion: row.last_nft_event_version,
    lastTransferTransactionHash: row.last_transfer_transaction_hash,
    item: { name: row.item_name, imageUrl: row.image_url, permalink: row.permalink },
    source: row.source,
    lastStreamReceivedAt: row.last_stream_received_at,
    lastReconciledAt: row.last_reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rawLastEvent: row.raw_last_event
  };
}

export async function getOrderStateForUpdate(client: Queryable, orderHash: string): Promise<OrderState | null> {
  const result = await client.query<OrderRow>(
    `SELECT
      order_hash, nft_id, chain, contract_address, token_id, collection_slug,
      seller_address, price_raw, price_normalized::text AS price_normalized,
      payment_token_address, payment_token_symbol, payment_token_decimals,
      listing_start_at::text AS listing_start_at, expiration_at::text AS expiration_at,
      status, is_active, needs_reconciliation, reconciliation_reason,
      last_order_event_type, last_order_event_timestamp::text AS last_order_event_timestamp,
      last_order_event_version::text AS last_order_event_version,
      last_nft_event_timestamp::text AS last_nft_event_timestamp,
      last_nft_event_version::text AS last_nft_event_version,
      last_transfer_transaction_hash, item_name, image_url, permalink, source,
      last_stream_received_at::text AS last_stream_received_at,
      last_reconciled_at::text AS last_reconciled_at,
      created_at::text AS created_at, updated_at::text AS updated_at, raw_last_event
     FROM public.opensea_listings_v2
     WHERE order_hash = $1
     FOR UPDATE`,
    [orderHash]
  );
  return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
}

export async function findActiveOrdersForNftForUpdate(client: Queryable, selector: ActiveOrderSelector): Promise<OrderState[]> {
  const result = await client.query<OrderRow>(
    `SELECT
      order_hash, nft_id, chain, contract_address, token_id, collection_slug,
      seller_address, price_raw, price_normalized::text AS price_normalized,
      payment_token_address, payment_token_symbol, payment_token_decimals,
      listing_start_at::text AS listing_start_at, expiration_at::text AS expiration_at,
      status, is_active, needs_reconciliation, reconciliation_reason,
      last_order_event_type, last_order_event_timestamp::text AS last_order_event_timestamp,
      last_order_event_version::text AS last_order_event_version,
      last_nft_event_timestamp::text AS last_nft_event_timestamp,
      last_nft_event_version::text AS last_nft_event_version,
      last_transfer_transaction_hash, item_name, image_url, permalink, source,
      last_stream_received_at::text AS last_stream_received_at,
      last_reconciled_at::text AS last_reconciled_at,
      created_at::text AS created_at, updated_at::text AS updated_at, raw_last_event
     FROM public.opensea_listings_v2
     WHERE chain = $1
       AND contract_address = $2
       AND token_id = $3
       AND status = 'active'
       AND is_active = true
     FOR UPDATE`,
    [selector.chain, selector.contractAddress, selector.tokenId]
  );
  return result.rows.map(mapOrderRow);
}

export async function upsertOrderState(client: Queryable, state: OrderState): Promise<void> {
  await client.query(
    `INSERT INTO public.opensea_listings_v2 (
      order_hash, nft_id, chain, contract_address, token_id, collection_slug,
      seller_address, price_raw, price_normalized, payment_token_address,
      payment_token_symbol, payment_token_decimals, listing_start_at, expiration_at,
      status, is_active, needs_reconciliation, reconciliation_reason,
      last_order_event_type, last_order_event_timestamp, last_order_event_version,
      last_nft_event_timestamp, last_nft_event_version, last_transfer_transaction_hash,
      item_name, image_url, permalink, source, last_stream_received_at,
      last_reconciled_at, created_at, updated_at, raw_last_event
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9::numeric, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18,
      $19, $20, $21::bigint,
      $22, $23::bigint, $24,
      $25, $26, $27, $28, $29,
      $30, $31, $32, $33::jsonb
    )
    ON CONFLICT (order_hash) DO UPDATE SET
      nft_id = EXCLUDED.nft_id,
      chain = EXCLUDED.chain,
      contract_address = EXCLUDED.contract_address,
      token_id = EXCLUDED.token_id,
      collection_slug = EXCLUDED.collection_slug,
      seller_address = EXCLUDED.seller_address,
      price_raw = EXCLUDED.price_raw,
      price_normalized = EXCLUDED.price_normalized,
      payment_token_address = EXCLUDED.payment_token_address,
      payment_token_symbol = EXCLUDED.payment_token_symbol,
      payment_token_decimals = EXCLUDED.payment_token_decimals,
      listing_start_at = EXCLUDED.listing_start_at,
      expiration_at = EXCLUDED.expiration_at,
      status = EXCLUDED.status,
      is_active = EXCLUDED.is_active,
      needs_reconciliation = EXCLUDED.needs_reconciliation,
      reconciliation_reason = EXCLUDED.reconciliation_reason,
      last_order_event_type = EXCLUDED.last_order_event_type,
      last_order_event_timestamp = EXCLUDED.last_order_event_timestamp,
      last_order_event_version = EXCLUDED.last_order_event_version,
      last_nft_event_timestamp = EXCLUDED.last_nft_event_timestamp,
      last_nft_event_version = EXCLUDED.last_nft_event_version,
      last_transfer_transaction_hash = EXCLUDED.last_transfer_transaction_hash,
      item_name = EXCLUDED.item_name,
      image_url = EXCLUDED.image_url,
      permalink = EXCLUDED.permalink,
      source = EXCLUDED.source,
      last_stream_received_at = EXCLUDED.last_stream_received_at,
      last_reconciled_at = EXCLUDED.last_reconciled_at,
      updated_at = EXCLUDED.updated_at,
      raw_last_event = EXCLUDED.raw_last_event`,
    [
      state.orderHash,
      state.nft.nftId,
      state.nft.chain,
      state.nft.contractAddress,
      state.nft.tokenId,
      state.collectionSlug,
      state.seller,
      state.price?.raw ?? null,
      state.price?.normalizedDecimalString ?? null,
      state.price?.tokenAddress ?? null,
      state.price?.symbol ?? null,
      state.price?.decimals ?? null,
      state.listingStartAt,
      state.expirationAt,
      state.status,
      state.isActive,
      state.needsReconciliation,
      state.reconciliationReason,
      state.lastOrderEventType,
      state.lastOrderEventTimestamp,
      state.lastOrderEventVersion,
      state.lastNftEventTimestamp,
      state.lastNftEventVersion,
      state.lastTransferTransactionHash,
      state.item.name,
      state.item.imageUrl,
      state.item.permalink,
      state.source,
      state.lastStreamReceivedAt,
      state.lastReconciledAt,
      state.createdAt,
      state.updatedAt,
      stringifyJsonb(state.rawLastEvent)
    ]
  );
}
