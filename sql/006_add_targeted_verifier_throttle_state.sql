BEGIN;

CREATE TABLE IF NOT EXISTS public.targeted_verifier_throttle_state (
  throttle_key text PRIMARY KEY CHECK (throttle_key = 'opensea-exact-order'),
  last_request_started_at timestamptz NULL
);

INSERT INTO public.targeted_verifier_throttle_state (throttle_key, last_request_started_at)
VALUES ('opensea-exact-order', NULL)
ON CONFLICT (throttle_key) DO NOTHING;

COMMIT;
