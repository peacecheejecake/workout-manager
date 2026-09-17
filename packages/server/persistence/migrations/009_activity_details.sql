-- Preserve legacy rows and immutable source revision identity; no invented detail backfill.
ALTER TABLE activity_source_revision ADD COLUMN details_json jsonb;
ALTER TABLE activity_source_revision ADD CONSTRAINT activity_details_size
  CHECK (details_json IS NULL OR (
    jsonb_typeof(details_json) = 'object'
    AND octet_length(details_json::text) <= 5242880
  ));
