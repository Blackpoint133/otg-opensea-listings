BEGIN;

CREATE TABLE IF NOT EXISTS public.targeted_verifier_generation_publication_sequence (
  sequence_key text PRIMARY KEY,
  publication_sequence bigint NOT NULL CHECK (publication_sequence >= 0)
);

INSERT INTO public.targeted_verifier_generation_publication_sequence (sequence_key, publication_sequence)
VALUES ('targeted-verifier-generation', 0)
ON CONFLICT (sequence_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.targeted_verifier_generation_publications (
  generation_publication_id text PRIMARY KEY,
  generation_commitment_id text NOT NULL,
  publication_sequence bigint NOT NULL CHECK (publication_sequence >= 0),
  publication_state text NOT NULL CHECK (publication_state IN ('ACCEPTED','REJECTED','SUPERSEDED')),
  sweep_id text NOT NULL,
  generation_root_hash text NOT NULL,
  candidate_artifact_hash text NOT NULL,
  barrier_artifact_hash text NOT NULL,
  candidate_model_version text NOT NULL,
  generation_model_version text NOT NULL,
  verifier_schema_version text NOT NULL,
  verifier_policy_version text NOT NULL,
  provider_contract_version text NOT NULL,
  normalizer_version text NOT NULL,
  scope jsonb NOT NULL,
  payload jsonb NOT NULL,
  source_evidence_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (generation_commitment_id, source_evidence_hash, publication_state)
);

CREATE INDEX IF NOT EXISTS targeted_verifier_generation_publications_current_idx
  ON public.targeted_verifier_generation_publications (publication_state, publication_sequence DESC);

COMMIT;
