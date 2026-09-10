import type { NftState } from "../state/types.js";
import type { Queryable } from "./types.js";

export const NFT_STATE_TABLE = "public.opensea_listings_nft_state_v2";

interface NftRow {
  chain: string;
  contract_address: string;
  token_id: string;
  nft_id: string;
  collection_slug: string;
  current_owner_address: string | null;
  last_transfer_from_address: string | null;
  last_transfer_to_address: string | null;
  last_transfer_transaction_hash: string | null;
  last_transfer_at: string | null;
  last_nft_event_timestamp: string | null;
  last_nft_event_version: string | null;
  item_name: string | null;
  image_url: string | null;
  permalink: string | null;
  metadata_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapNftRow(row: NftRow): NftState {
  return {
    identity: { nftId: row.nft_id, chain: row.chain, contractAddress: row.contract_address, tokenId: row.token_id },
    collectionSlug: row.collection_slug,
    currentOwnerAddress: row.current_owner_address,
    lastTransferFromAddress: row.last_transfer_from_address,
    lastTransferToAddress: row.last_transfer_to_address,
    lastTransferTransactionHash: row.last_transfer_transaction_hash,
    lastTransferAt: row.last_transfer_at,
    lastNftEventTimestamp: row.last_nft_event_timestamp,
    lastNftEventVersion: row.last_nft_event_version,
    item: { name: row.item_name, imageUrl: row.image_url, permalink: row.permalink },
    metadataUpdatedAt: row.metadata_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getNftStateForUpdate(client: Queryable, chain: string, contractAddress: string, tokenId: string): Promise<NftState | null> {
  const result = await client.query<NftRow>(
    `SELECT
      chain, contract_address, token_id, nft_id, collection_slug,
      current_owner_address, last_transfer_from_address, last_transfer_to_address,
      last_transfer_transaction_hash, last_transfer_at::text AS last_transfer_at,
      last_nft_event_timestamp::text AS last_nft_event_timestamp,
      last_nft_event_version::text AS last_nft_event_version,
      item_name, image_url, permalink, metadata_updated_at::text AS metadata_updated_at,
      created_at::text AS created_at, updated_at::text AS updated_at
     FROM public.opensea_listings_nft_state_v2
     WHERE chain = $1 AND contract_address = $2 AND token_id = $3
     FOR UPDATE`,
    [chain, contractAddress, tokenId]
  );
  return result.rows[0] ? mapNftRow(result.rows[0]) : null;
}

export async function upsertNftState(client: Queryable, state: NftState): Promise<void> {
  await client.query(
    `INSERT INTO public.opensea_listings_nft_state_v2 (
      chain, contract_address, token_id, nft_id, collection_slug,
      current_owner_address, last_transfer_from_address, last_transfer_to_address,
      last_transfer_transaction_hash, last_transfer_at, last_nft_event_timestamp,
      last_nft_event_version, item_name, image_url, permalink, metadata_updated_at,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12::bigint, $13, $14, $15, $16,
      $17, $18
    )
    ON CONFLICT (chain, contract_address, token_id) DO UPDATE SET
      nft_id = EXCLUDED.nft_id,
      collection_slug = EXCLUDED.collection_slug,
      current_owner_address = EXCLUDED.current_owner_address,
      last_transfer_from_address = EXCLUDED.last_transfer_from_address,
      last_transfer_to_address = EXCLUDED.last_transfer_to_address,
      last_transfer_transaction_hash = EXCLUDED.last_transfer_transaction_hash,
      last_transfer_at = EXCLUDED.last_transfer_at,
      last_nft_event_timestamp = EXCLUDED.last_nft_event_timestamp,
      last_nft_event_version = EXCLUDED.last_nft_event_version,
      item_name = EXCLUDED.item_name,
      image_url = EXCLUDED.image_url,
      permalink = EXCLUDED.permalink,
      metadata_updated_at = EXCLUDED.metadata_updated_at,
      updated_at = EXCLUDED.updated_at`,
    [
      state.identity.chain,
      state.identity.contractAddress,
      state.identity.tokenId,
      state.identity.nftId,
      state.collectionSlug,
      state.currentOwnerAddress,
      state.lastTransferFromAddress,
      state.lastTransferToAddress,
      state.lastTransferTransactionHash,
      state.lastTransferAt,
      state.lastNftEventTimestamp,
      state.lastNftEventVersion,
      state.item.name,
      state.item.imageUrl,
      state.item.permalink,
      state.metadataUpdatedAt,
      state.createdAt,
      state.updatedAt
    ]
  );
}
