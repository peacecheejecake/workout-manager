-- Scenario names are user-defined alternatives scoped to a saved base plan version.
-- A/B/C from migration 011 remain valid examples; they are not reserved slots.
ALTER TABLE plan_scenario DROP CONSTRAINT IF EXISTS plan_scenario_label_check;
ALTER TABLE plan_scenario
  ADD CONSTRAINT plan_scenario_label_format
  CHECK (char_length(btrim(label)) BETWEEN 1 AND 80);
