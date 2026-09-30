-- Only the immutable suppression facts may enter this local publication.
-- Creating the publication does not create a slot, exporter, remote acknowledgement,
-- or a backup/restore completeness proof.
CREATE PUBLICATION workout_restore_suppression_events
  FOR TABLE public.restore_suppression_event
  WITH (publish = 'insert');
