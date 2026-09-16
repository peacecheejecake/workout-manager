ALTER TABLE activity_source_head DROP CONSTRAINT activity_source_head_kind_check;
ALTER TABLE activity_source_head ADD CONSTRAINT activity_source_head_kind_check CHECK (kind IN ('fit','fixture','manual'));
ALTER TABLE activity_overlay DROP CONSTRAINT activity_overlay_values_json_check;
ALTER TABLE activity_overlay ADD CONSTRAINT activity_overlay_values_json_check CHECK (octet_length(values_json::text) <= 32768);
ALTER TABLE activity_overlay_revision DROP CONSTRAINT activity_overlay_revision_values_json_check;
ALTER TABLE activity_overlay_revision ADD CONSTRAINT activity_overlay_revision_values_json_check CHECK (octet_length(values_json::text) <= 32768);
