BEGIN;

CREATE TABLE IF NOT EXISTS public.targeted_verifier_permits (
  permit_id text PRIMARY KEY,
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_start_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS targeted_verifier_permits_expiry_idx
  ON public.targeted_verifier_permits (expires_at);

COMMIT;
