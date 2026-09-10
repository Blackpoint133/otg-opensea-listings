BEGIN;

ALTER TABLE public.opensea_listings_events_v2
    ADD COLUMN processing_status text,
    ADD COLUMN attempt_count integer,
    ADD COLUMN processing_started_at timestamptz,
    ADD COLUMN last_attempt_at timestamptz,
    ADD COLUMN next_retry_at timestamptz,
    ADD COLUMN last_error_code text,
    ADD COLUMN last_error_message text;

UPDATE public.opensea_listings_events_v2
SET processing_status = CASE
        WHEN apply_result IS NULL OR applied_at IS NULL THEN 'pending'
        WHEN apply_result LIKE 'ignored_older%' THEN 'ignored_older'
        WHEN event_type = 'item_transferred' THEN 'reconciliation_required'
        WHEN apply_result LIKE '%reconciliation%' THEN 'reconciliation_required'
        ELSE 'applied'
    END,
    attempt_count = CASE
        WHEN apply_result IS NULL OR applied_at IS NULL THEN 0
        ELSE 1
    END,
    last_attempt_at = CASE
        WHEN apply_result IS NULL OR applied_at IS NULL THEN NULL
        ELSE applied_at
    END,
    processing_started_at = NULL,
    next_retry_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.opensea_listings_events_v2
        WHERE processing_status IS NULL
           OR attempt_count IS NULL
           OR attempt_count < 0
           OR processing_status NOT IN (
                'pending',
                'processing',
                'applied',
                'reconciliation_required',
                'failed',
                'ignored_duplicate',
                'ignored_older'
           )
    ) THEN
        RAISE EXCEPTION 'opensea_listings_events_v2 lifecycle backfill violated contract';
    END IF;
END $$;

ALTER TABLE public.opensea_listings_events_v2
    ALTER COLUMN processing_status SET DEFAULT 'applied',
    ALTER COLUMN processing_status SET NOT NULL,
    ALTER COLUMN attempt_count SET DEFAULT 0,
    ALTER COLUMN attempt_count SET NOT NULL,
    ADD CONSTRAINT opensea_listings_events_v2_processing_status_check
        CHECK (processing_status IN (
            'pending',
            'processing',
            'applied',
            'reconciliation_required',
            'failed',
            'ignored_duplicate',
            'ignored_older'
        )),
    ADD CONSTRAINT opensea_listings_events_v2_attempt_count_check
        CHECK (attempt_count >= 0);

COMMIT;
