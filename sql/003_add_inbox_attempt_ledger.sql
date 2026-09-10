BEGIN;

CREATE TABLE public.opensea_listings_events_v2_attempts (
    event_id bigint NOT NULL REFERENCES public.opensea_listings_events_v2(event_id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (event_id, attempt_id)
);

CREATE INDEX opensea_listings_events_v2_attempts_recorded_idx
    ON public.opensea_listings_events_v2_attempts (recorded_at);

COMMIT;
