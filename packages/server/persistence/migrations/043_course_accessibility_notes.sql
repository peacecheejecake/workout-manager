-- M2-01r stores the owner's accessibility note about a course (S13 "접근성 메모").
--
-- A note is what the owner wrote down about getting along a course: stairs, a steep ramp,
-- a gate that is locked at night. It is stored because nothing can rebuild it. It is NOT
-- course content, and it lives in its own table so that is structural rather than a habit:
-- writing a note appends no revision, moves no head, enters no content digest and is not
-- part of the GPX export. It is the owner's claim, never a fact the product checked.
--
-- A note names the head revision it was written against. The line can change afterwards —
-- a reroute or a privacy trim appends a revision — and a note about stairs on the old line
-- is not a note about the new one. The screen compares the two instead of presenting an
-- old note as current. The revision is not a foreign key: a revision number outlives
-- nothing here, it is only the value the owner was looking at.
--
-- Lifecycle, stated once:
--   * Deleting a course takes its note with it through the foreign key below.
--   * Erasing an account deletes every `course` row (migration 034), and the same cascade
--     takes every note. `erase_account` is therefore NOT wrapped again here: the note has
--     no row of its own that could outlive the course, and adding one more link to that
--     chain would add one more place to get the lock order wrong.
--   * Reclaiming a course whose source activity was deleted keeps the course row as an
--     unavailable reference with its name, and keeps the note beside it: both are the
--     owner's own words, neither is a coordinate from the recording. A note cannot be
--     written against an unavailable course, because it has no head to be written against.
--
-- Nothing earlier is edited. This migration adds one table, its policy and nothing else.

CREATE TABLE course_accessibility_note (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  course_id uuid NOT NULL,
  -- One line of the owner's text, held to the course-name rule: bounded, trimmed. The
  -- contract refuses control, bidirectional-override and angle-bracket characters.
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 256 AND note=btrim(note)),
  written_at_revision integer NOT NULL CHECK (written_at_revision BETWEEN 1 AND 2147483646),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,course_id),
  CHECK (updated_at>=created_at),
  FOREIGN KEY (athlete_id,course_id) REFERENCES course(athlete_id,course_id) ON DELETE CASCADE
);

ALTER TABLE course_accessibility_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_accessibility_note FORCE ROW LEVEL SECURITY;
CREATE POLICY course_tenant ON course_accessibility_note
  USING (athlete_id=nullif(current_setting('app.athlete_id',true),''))
  WITH CHECK (athlete_id=nullif(current_setting('app.athlete_id',true),''));
