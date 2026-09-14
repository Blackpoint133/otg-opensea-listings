BEGIN;

CREATE TABLE IF NOT EXISTS public.targeted_verifier_shadow_decisions (
  shadow_decision_id text PRIMARY KEY,
  persist_sequence bigserial UNIQUE NOT NULL,
  shadow_evaluation_id text NOT NULL,
  shadow_evidence_hash text NOT NULL,
  attempt_id text NOT NULL,
  order_hash text NOT NULL,
  generation_publication_id text NOT NULL,
  generation_commitment_id text NOT NULL,
  active_evidence_id text NOT NULL,
  state text NOT NULL,
  previous_decision_id text NULL,
  payload jsonb NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX IF NOT EXISTS targeted_verifier_shadow_decisions_attempt_idx
  ON public.targeted_verifier_shadow_decisions (attempt_id, persist_sequence);
CREATE INDEX IF NOT EXISTS targeted_verifier_shadow_decisions_order_idx
  ON public.targeted_verifier_shadow_decisions (order_hash, persist_sequence);
CREATE INDEX IF NOT EXISTS targeted_verifier_shadow_decisions_evaluation_idx
  ON public.targeted_verifier_shadow_decisions (shadow_evaluation_id);
CREATE INDEX IF NOT EXISTS targeted_verifier_shadow_decisions_state_idx
  ON public.targeted_verifier_shadow_decisions (state);

COMMIT;
