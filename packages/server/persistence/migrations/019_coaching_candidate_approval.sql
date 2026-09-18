-- Explicit approval is the only candidate path that creates a plan version.
ALTER TABLE plan_history DROP CONSTRAINT plan_history_action_check;
ALTER TABLE plan_history ADD CONSTRAINT plan_history_action_check
 CHECK(action IN ('manual_saved','scenario_applied','candidate_approved'));
