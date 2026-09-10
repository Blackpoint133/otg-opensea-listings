BEGIN;

-- Reviewed one-shot migration: preflight must confirm these V2 tables do not already exist.

CREATE TABLE public.opensea_listings_v2 (
    order_hash text PRIMARY KEY,
    nft_id text NOT NULL,
    chain text NOT NULL,
    contract_address text NOT NULL,
    token_id text NOT NULL,
    collection_slug text NOT NULL,
    seller_address text,
    price_raw text,
    price_normalized numeric(78,18),
    payment_token_address text,
    payment_token_symbol text,
    payment_token_decimals smallint,
    listing_start_at timestamptz,
    expiration_at timestamptz,
    status text NOT NULL CHECK (status IN ('active', 'cancelled', 'sold', 'invalidated', 'expired', 'stale', 'unknown')),
    is_active boolean NOT NULL DEFAULT false,
    needs_reconciliation boolean NOT NULL DEFAULT false,
    reconciliation_reason text,
    last_order_event_type text,
    last_order_event_timestamp timestamptz,
    last_order_event_version bigint,
    last_nft_event_timestamp timestamptz,
    last_nft_event_version bigint,
    last_transfer_transaction_hash text,
    item_name text,
    image_url text,
    permalink text,
    source text NOT NULL,
    last_stream_received_at timestamptz,
    last_reconciled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    raw_last_event jsonb NOT NULL,
    CONSTRAINT opensea_listings_v2_payment_decimals_check CHECK (payment_token_decimals IS NULL OR payment_token_decimals >= 0),
    CONSTRAINT opensea_listings_v2_price_check CHECK (price_normalized IS NULL OR price_normalized >= 0),
    CONSTRAINT opensea_listings_v2_expiration_check CHECK (expiration_at IS NULL OR listing_start_at IS NULL OR expiration_at >= listing_start_at)
);

CREATE INDEX opensea_listings_v2_collection_live_idx
    ON public.opensea_listings_v2 (collection_slug, is_active, status, expiration_at);
CREATE INDEX opensea_listings_v2_nft_active_idx
    ON public.opensea_listings_v2 (chain, contract_address, token_id, is_active);
CREATE INDEX opensea_listings_v2_seller_active_idx
    ON public.opensea_listings_v2 (seller_address, is_active);
CREATE INDEX opensea_listings_v2_order_event_time_idx
    ON public.opensea_listings_v2 (last_order_event_timestamp);
CREATE INDEX opensea_listings_v2_reconciliation_idx
    ON public.opensea_listings_v2 (needs_reconciliation);
CREATE INDEX opensea_listings_v2_live_partial_idx
    ON public.opensea_listings_v2 (collection_slug, expiration_at)
    WHERE is_active = true AND status = 'active';

CREATE TABLE public.opensea_listings_nft_state_v2 (
    chain text NOT NULL,
    contract_address text NOT NULL,
    token_id text NOT NULL,
    nft_id text NOT NULL,
    collection_slug text NOT NULL,
    current_owner_address text,
    last_transfer_from_address text,
    last_transfer_to_address text,
    last_transfer_transaction_hash text,
    last_transfer_at timestamptz,
    last_nft_event_timestamp timestamptz,
    last_nft_event_version bigint,
    item_name text,
    image_url text,
    permalink text,
    metadata_updated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain, contract_address, token_id),
    CONSTRAINT opensea_listings_nft_state_v2_nft_id_unique UNIQUE (nft_id)
);

CREATE INDEX opensea_listings_nft_state_v2_collection_idx
    ON public.opensea_listings_nft_state_v2 (collection_slug, contract_address, token_id);
CREATE INDEX opensea_listings_nft_state_v2_owner_idx
    ON public.opensea_listings_nft_state_v2 (current_owner_address);
CREATE INDEX opensea_listings_nft_state_v2_event_time_idx
    ON public.opensea_listings_nft_state_v2 (last_nft_event_timestamp);

CREATE TABLE public.opensea_listings_events_v2 (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type text NOT NULL,
    event_timestamp timestamptz,
    event_version bigint,
    order_hash text,
    nft_id text,
    chain text,
    contract_address text,
    token_id text,
    transaction_hash text,
    received_at timestamptz NOT NULL,
    payload_hash text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    raw_payload jsonb NOT NULL,
    apply_result text,
    applied_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX opensea_listings_events_v2_order_time_idx
    ON public.opensea_listings_events_v2 (order_hash, event_timestamp);
CREATE INDEX opensea_listings_events_v2_nft_time_idx
    ON public.opensea_listings_events_v2 (chain, contract_address, token_id, event_timestamp);
CREATE INDEX opensea_listings_events_v2_type_time_idx
    ON public.opensea_listings_events_v2 (event_type, event_timestamp);
CREATE INDEX opensea_listings_events_v2_payload_hash_idx
    ON public.opensea_listings_events_v2 (payload_hash);
CREATE INDEX opensea_listings_events_v2_apply_idx
    ON public.opensea_listings_events_v2 (apply_result, applied_at);

COMMIT;
