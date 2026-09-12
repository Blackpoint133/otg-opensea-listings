BEGIN;

CREATE TABLE IF NOT EXISTS public.targeted_verifier_attempts (
  attempt_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  attempt_number integer NOT NULL CHECK (attempt_number >= 0),
  sweep_id text NOT NULL,
  order_hash text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('NOT_STARTED','REQUEST_PENDING','RESPONSE_OBSERVED','PENDING_FENCE','COMPLETE','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NULL,
  lease_expires_at timestamptz NULL,
  lease_token text NULL,
  next_attempt_at timestamptz NULL,
  failure_classification text NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS targeted_verifier_attempts_due_idx
  ON public.targeted_verifier_attempts (lifecycle, next_attempt_at, created_at);

COMMIT;
