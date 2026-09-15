BEGIN;

CREATE TABLE public.opensea_listings_initial_baseline_adoptions (
  schema_version text NOT NULL,
  adoption_id text PRIMARY KEY,
  generation_publication_id text NOT NULL REFERENCES public.targeted_verifier_generation_publications(generation_publication_id),
  publication_sequence bigint NOT NULL CHECK (publication_sequence >= 0),
  sweep_id text NOT NULL,
  source_evidence_hash text NOT NULL CHECK (source_evidence_hash ~ '^[0-9a-f]{64}$'),
  generation_root_hash text NOT NULL CHECK (generation_root_hash ~ '^[0-9a-f]{64}$'),
  candidate_artifact_hash text NOT NULL CHECK (candidate_artifact_hash ~ '^[0-9a-f]{64}$'),
  barrier_artifact_hash text NOT NULL CHECK (barrier_artifact_hash ~ '^[0-9a-f]{64}$'),
  scope jsonb NOT NULL,
  scope_fingerprint text NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  protocol_address text NOT NULL CHECK (protocol_address ~ '^0x[0-9a-f]{40}$'),
  stable_event_id bigint NOT NULL CHECK (stable_event_id >= 0),
  stable_received_at timestamptz NOT NULL,
  snapshot_started_at timestamptz NOT NULL,
  snapshot_completed_at timestamptz NOT NULL CHECK (snapshot_completed_at >= snapshot_started_at),
  expected_order_count integer NOT NULL CHECK (expected_order_count > 0),
  adopted_order_count integer NOT NULL CHECK (adopted_order_count = expected_order_count),
  rows_commitment text NOT NULL CHECK (rows_commitment ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  adopted_at timestamptz NOT NULL,
  CONSTRAINT one_initial_adoption_per_publication UNIQUE (generation_publication_id)
);

ALTER TABLE public.opensea_listings_v2
  ADD COLUMN protocol_address text NULL,
  ADD COLUMN initial_baseline_adoption_id text NULL REFERENCES public.opensea_listings_initial_baseline_adoptions(adoption_id),
  ADD COLUMN raw_baseline_listing jsonb NULL;

ALTER TABLE public.opensea_listings_v2
  ADD CONSTRAINT listings_protocol_address_canonical CHECK (protocol_address IS NULL OR protocol_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT listings_baseline_provenance_all_or_none CHECK (initial_baseline_adoption_id IS NULL OR (protocol_address IS NOT NULL AND raw_baseline_listing IS NOT NULL));

CREATE INDEX opensea_listings_v2_initial_baseline_adoption_idx ON public.opensea_listings_v2(initial_baseline_adoption_id);

COMMIT;
