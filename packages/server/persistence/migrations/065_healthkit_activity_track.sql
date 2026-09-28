-- The track ledger's source_kind identifies the canonical Activity's owner source, not
-- the file uploaded for its track. A HealthKit-owned Activity may receive an explicit
-- user-provided FIT/GPX recording; recorded_source_kind and format keep that recording's
-- provenance separate. Existing owner FK, tenant RLS, revision and suppression checks stay.
ALTER TABLE activity_track DROP CONSTRAINT activity_track_source_kind_check;
ALTER TABLE activity_track ADD CONSTRAINT activity_track_source_kind_check
  CHECK (source_kind IN ('fit','fixture','manual','healthkit'));

ALTER TABLE activity_track_revision DROP CONSTRAINT activity_track_revision_source_kind_check;
ALTER TABLE activity_track_revision ADD CONSTRAINT activity_track_revision_source_kind_check
  CHECK (source_kind IN ('fit','fixture','manual','healthkit'));

ALTER TABLE activity_track_upload_intent
  DROP CONSTRAINT activity_track_upload_intent_source_kind_check;
ALTER TABLE activity_track_upload_intent
  ADD CONSTRAINT activity_track_upload_intent_source_kind_check
  CHECK (source_kind IN ('fit','fixture','manual','healthkit'));
