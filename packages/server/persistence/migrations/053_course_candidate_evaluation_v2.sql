-- M2-01ap: target-distance candidates are measured under evaluation version 2.
--
-- Version 2 differs from version 1 only in `knowledge`: stairs, surface and access
-- restrictions come from the engine's path details (road_class, surface, road_access,
-- foot_access) instead of being fixed to `unknown`. Version 1 stays valid everywhere: a
-- search, a candidate or a revision written under it is never rewritten, and it keeps
-- reading `unknown`, which was true when it was measured.
--
-- Two bounds change, and nothing else:
--
--   * `course_route_candidate_set.evaluation_version` accepts 2 as well as 1. The search row
--     records the version its candidates were measured under; a search never mixes two
--     (the application refuses it before writing).
--   * `course_revision.generation` may hold up to 8192 bytes instead of 4096. A
--     `target-distance-loop` generation carries the whole evaluation, and version 2's
--     knowledge lists every surface and every restriction value the line crosses with its
--     length. The contract bounds each list by its value set (15 surfaces, 9 restriction
--     values, 2 stair values); at those bounds a generation serialises to about 4.1 kB before
--     jsonb's own spacing, over the old limit. 8192 is the bound `candidate_evaluation`
--     already has, so a candidate that could be stored can also be saved.
--
-- Widening a CHECK leaves every existing row valid, and the write-once triggers on both
-- tables are untouched: no stored row changes.

ALTER TABLE course_route_candidate_set
  DROP CONSTRAINT course_route_candidate_set_evaluation_version_check,
  ADD CONSTRAINT course_route_candidate_set_evaluation_version_check
    CHECK (evaluation_version IN (1,2));

ALTER TABLE course_revision
  DROP CONSTRAINT course_revision_generation_check,
  ADD CONSTRAINT course_revision_generation_check
    CHECK (jsonb_typeof(generation)='object' AND octet_length(generation::text)<=8192);
