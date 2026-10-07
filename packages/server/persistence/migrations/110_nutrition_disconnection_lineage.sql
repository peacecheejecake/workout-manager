-- Authenticated runtime-only SQL110 atomic V4 commit and privacy successors.
-- Registration, EXECUTE grants, public writer/read dispatch and archive closure are Root-owned.
CREATE TABLE public.nutrition_race_disconnection_lineage (
 athlete_id text NOT NULL,
 plan_id uuid NOT NULL,
 version_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 2 AND 2147483646),
 prior_version_id uuid NOT NULL,
 prior_version integer NOT NULL,
 item_key bytea NOT NULL CHECK(octet_length(item_key)=32),
 item_id text NOT NULL CHECK(length(item_id)>0 AND item_id=btrim(item_id)),
 origin_version_id uuid NOT NULL,
 origin_event_id uuid NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('retained','reconnected','carried')),
 prior_row_digest_version text NOT NULL CHECK(prior_row_digest_version='postgres-row-jsonb-utc-v1'),
 prior_row_digest text NOT NULL CHECK(prior_row_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(athlete_id,version_id,item_key),
 CHECK(version=prior_version+1 AND version_id<>prior_version_id),
 CHECK(item_key=sha256(convert_to(item_id,'UTF8'))),
 FOREIGN KEY(athlete_id,plan_id,version,version_id)
  REFERENCES public.nutrition_plan_version(athlete_id,plan_id,version,version_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(athlete_id,plan_id,prior_version,prior_version_id)
  REFERENCES public.nutrition_plan_version(athlete_id,plan_id,version,version_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(athlete_id,origin_version_id,item_key)
  REFERENCES public.nutrition_race_item_disconnection(athlete_id,version_id,item_key) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(origin_event_id) REFERENCES public.restore_suppression_event(event_id)
);
REVOKE ALL ON public.nutrition_race_disconnection_lineage FROM PUBLIC;
ALTER TABLE public.nutrition_race_disconnection_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nutrition_race_disconnection_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.nutrition_race_disconnection_lineage
 USING(athlete_id=nullif(current_setting('app.athlete_id',true),''))
 WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));

CREATE FUNCTION public.nutrition_v4_wire_schema(k text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $codec$ SELECT CASE k WHEN 'version' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":4},"period":{"type":"object","properties":{"from":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"toInclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"required":["from","toInclusive"],"additionalProperties":false},"timezone":{"type":"string"},"purpose":{"type":"string","maxLength":160},"linkedTrainingPlanVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"planId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"versionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"items":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"planVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"category":{"type":"string","enum":["meal","snack","before","during","after","hydration"]},"title":{"type":"string","maxLength":160},"anchor":{"anyOf":[{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absolute"},"date":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]},"timezone":{"type":"string"}},"required":["kind","date","localTime","timezone"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"relative"},"entity":{"type":"string","enum":["session","race"]},"entityId":{"type":"string"},"point":{"type":"string","enum":["start","end"]},"offsetMinutes":{"type":"number"}},"required":["kind","entity","entityId","point","offsetMinutes"],"additionalProperties":false}]},{"type":"object","properties":{"kind":{"type":"string","const":"disconnected"},"entity":{"type":"string","const":"race"}},"required":["kind","entity"],"additionalProperties":false}]},"foods":{"maxItems":40,"type":"array","items":{"type":"object","properties":{"foodVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"description":{"type":"string","maxLength":160},"quantity":{"anyOf":[{"type":"number","minimum":0},{"type":"null"}]},"unit":{"type":"string","enum":["g","mL","serving","piece","unspecified"]},"sourceBasis":{"type":"string","enum":["per_100g","per_100mL","per_serving","manual_total","unknown"]}},"required":["foodVersionId","description","quantity","unit","sourceBasis"],"additionalProperties":false}},"targets":{"maxItems":6,"type":"array","items":{"oneOf":[{"type":"object","properties":{"metric":{"type":"string","const":"energy"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"kcal"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"carbohydrate"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"protein"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"fat"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"fluid"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"mL"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"sodium"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"mg"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false}]}},"instructions":{"type":"string","maxLength":2000},"evidenceIds":{"maxItems":40,"type":"array","items":{"type":"string"}},"source":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]}},"required":["id","planVersionId","category","title","anchor","foods","targets","instructions","evidenceIds","source"],"additionalProperties":false}},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"previousVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"approvedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"approvalId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"raceTimingPins":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"pinVersion":{"type":"number","const":1},"namespace":{"type":"string","const":"race-event-revision"},"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"eventRevision":{"type":"integer","minimum":1,"maximum":2147483647},"sourceDigestVersion":{"type":"string","const":"race-event-values-canonical-v1"},"sourceDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"localDate":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"localStartTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]},"timezone":{"type":"string"},"start":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"known"},"instant":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["state","instant"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"unknown"},"reason":{"type":"string","enum":["start_time_not_recorded","ambiguous_local_time"]}},"required":["state","reason"],"additionalProperties":false}]},"end":{"type":"object","properties":{"state":{"type":"string","const":"unknown"},"reason":{"type":"string","const":"race_end_not_recorded"}},"required":["state","reason"],"additionalProperties":false}},"required":["pinVersion","namespace","eventId","eventRevision","sourceDigestVersion","sourceDigest","localDate","localStartTime","timezone","start","end"],"additionalProperties":false}},"itemRaceTimingBindings":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"itemId":{"type":"string"},"binding":{"oneOf":[{"type":"object","properties":{"state":{"type":"string","const":"captured"},"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"eventRevision":{"type":"integer","minimum":1,"maximum":2147483647}},"required":["state","eventId","eventRevision"],"additionalProperties":false},{"type":"object","properties":{"state":{"type":"string","const":"legacy_unpinned"},"priorNutritionVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"priorItemId":{"type":"string"},"priorAnchorDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["state","priorNutritionVersionId","priorItemId","priorAnchorDigest"],"additionalProperties":false}]}},"required":["itemId","binding"],"additionalProperties":false}}},"required":["schemaVersion","period","timezone","purpose","linkedTrainingPlanVersionId","planId","versionId","items","version","previousVersionId","approvedAt","approvalId","raceTimingPins","itemRaceTimingBindings"],"additionalProperties":false}'::jsonb WHEN 'intent' THEN '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":4},"intent":{"type":"object","properties":{"schemaVersion":{"type":"number","const":3},"command":{"type":"object","properties":{"kind":{"type":"string","const":"update"},"planId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"expectedHeadVersionId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[a-zA-Z0-9_-]+$"},"confirmed":{"type":"boolean","const":true},"draft":{"type":"object","properties":{"period":{"type":"object","properties":{"from":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"toInclusive":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"}},"required":["from","toInclusive"],"additionalProperties":false},"timezone":{"type":"string"},"purpose":{"type":"string","maxLength":160},"linkedTrainingPlanVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"items":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"category":{"type":"string","enum":["meal","snack","before","during","after","hydration"]},"title":{"type":"string","maxLength":160},"anchor":{"anyOf":[{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"absolute"},"date":{"type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"localTime":{"anyOf":[{"type":"string","pattern":"^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$"},{"type":"null"}]},"timezone":{"type":"string"}},"required":["kind","date","localTime","timezone"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"relative"},"entity":{"type":"string","enum":["session","race"]},"entityId":{"type":"string"},"point":{"type":"string","enum":["start","end"]},"offsetMinutes":{"type":"number"}},"required":["kind","entity","entityId","point","offsetMinutes"],"additionalProperties":false}]},{"type":"object","properties":{"kind":{"type":"string","const":"disconnected"},"entity":{"type":"string","const":"race"}},"required":["kind","entity"],"additionalProperties":false}]},"foods":{"maxItems":40,"type":"array","items":{"type":"object","properties":{"foodVersionId":{"anyOf":[{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},{"type":"null"}]},"description":{"type":"string","maxLength":160},"quantity":{"anyOf":[{"type":"number","minimum":0},{"type":"null"}]},"unit":{"type":"string","enum":["g","mL","serving","piece","unspecified"]},"sourceBasis":{"type":"string","enum":["per_100g","per_100mL","per_serving","manual_total","unknown"]}},"required":["foodVersionId","description","quantity","unit","sourceBasis"],"additionalProperties":false}},"targets":{"maxItems":6,"type":"array","items":{"oneOf":[{"type":"object","properties":{"metric":{"type":"string","const":"energy"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"kcal"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"carbohydrate"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"protein"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"fat"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"g"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"fluid"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"mL"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false},{"type":"object","properties":{"metric":{"type":"string","const":"sodium"},"amount":{"type":"object","properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","minimum":0},"unit":{"type":"string","const":"mg"},"basis":{"type":"string","enum":["user_confirmed","reviewed_rule","draft_suggestion"]},"evidenceIds":{"type":"array","items":{"type":"string"}}},"required":["min","max","unit","basis","evidenceIds"],"additionalProperties":false}},"required":["metric","amount"],"additionalProperties":false}]}},"instructions":{"type":"string","maxLength":2000},"evidenceIds":{"maxItems":40,"type":"array","items":{"type":"string"}},"source":{"type":"string","const":"user_confirmed"}},"required":["id","category","title","anchor","foods","targets","instructions","evidenceIds","source"],"additionalProperties":false}}},"required":["period","timezone","purpose","linkedTrainingPlanVersionId","items"],"additionalProperties":false}},"required":["kind","planId","expectedHeadVersionId","idempotencyKey","confirmed","draft"],"additionalProperties":false},"expectedRaceHeads":{"maxItems":5000,"type":"array","items":{"type":"object","properties":{"namespace":{"type":"string","const":"race-event"},"eventId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"revision":{"type":"integer","minimum":1,"maximum":2147483647}},"required":["namespace","eventId","revision"],"additionalProperties":false}},"reconnectItemIds":{"maxItems":5000,"type":"array","items":{"type":"string"}}},"required":["schemaVersion","command","expectedRaceHeads","reconnectItemIds"],"additionalProperties":false}},"required":["schemaVersion","intent"],"additionalProperties":false}'::jsonb END $codec$;
REVOKE ALL ON FUNCTION public.nutrition_v4_wire_schema(text) FROM PUBLIC;

-- No raw request/body/source timestamp is retained in the command seal.
CREATE TABLE public.nutrition_v4_commit_seal (
 athlete_id text NOT NULL, version_id uuid NOT NULL, plan_id uuid NOT NULL,
 prior_version_id uuid NOT NULL, caller_role name NOT NULL, owner_xid bigint NOT NULL,
 app_revision integer NOT NULL, receipt_key text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 saved_digest text NOT NULL CHECK(saved_digest ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL, PRIMARY KEY(athlete_id,version_id), UNIQUE(athlete_id,receipt_key),
 FOREIGN KEY(athlete_id,version_id) REFERENCES public.nutrition_plan_version(athlete_id,version_id) DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON public.nutrition_v4_commit_seal FROM PUBLIC;
ALTER TABLE public.nutrition_v4_commit_seal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nutrition_v4_commit_seal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.nutrition_v4_commit_seal USING(athlete_id=nullif(current_setting('app.athlete_id',true),'')) WITH CHECK(athlete_id=nullif(current_setting('app.athlete_id',true),''));
CREATE FUNCTION public.assert_nutrition_v4_caller() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF session_user=current_user OR pg_has_role(session_user,current_user,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND relkind IN ('r','p'))
  OR current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.nutrition_v4_commit_seal'::regclass))
 THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_COMMIT_PROTOCOL_REQUIRED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_nutrition_v4_caller() FROM PUBLIC;
CREATE FUNCTION public.guard_nutrition_v4_seal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=OLD.athlete_id) THEN RAISE EXCEPTION 'IMMUTABLE_NUTRITION_SEAL'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMMUTABLE_NUTRITION_SEAL'; END IF;
 PERFORM public.assert_nutrition_v4_caller();
 IF NEW.caller_role<>session_user OR NEW.owner_xid<>txid_current() OR NEW.expires_at<=statement_timestamp()
  OR NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  OR public.require_app_admission_revision(NEW.app_revision)<>NEW.app_revision
 THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_COMMIT_PROTOCOL_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_nutrition_v4_seal() FROM PUBLIC;
CREATE TRIGGER nutrition_v4_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.nutrition_v4_commit_seal FOR EACH ROW EXECUTE FUNCTION public.guard_nutrition_v4_seal();
CREATE TRIGGER nutrition_v4_seal_no_truncate BEFORE TRUNCATE ON public.nutrition_v4_commit_seal FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

CREATE FUNCTION public.nutrition_v4_origin(t text,p uuid,v uuid,i text) RETURNS TABLE(origin_version_id uuid,origin_event_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT d.version_id,d.event_id FROM public.nutrition_plan_version saved
 JOIN public.nutrition_race_item_disconnection d ON d.athlete_id=saved.athlete_id AND d.version_id=saved.version_id
 JOIN public.restore_suppression_event e ON e.athlete_id=d.athlete_id AND e.event_id=d.event_id AND e.record_version=4 AND e.kind='race_event_deleted'
 WHERE saved.athlete_id=t AND saved.plan_id=p AND saved.version_id=v AND d.item_key=sha256(convert_to(i,'UTF8')) AND d.item_id=i
 UNION ALL
 SELECT l.origin_version_id,l.origin_event_id FROM public.nutrition_race_disconnection_lineage l
 JOIN public.nutrition_plan_version a ON a.athlete_id=l.athlete_id AND a.plan_id=l.plan_id AND a.version_id=l.origin_version_id
 JOIN public.nutrition_race_item_disconnection d ON d.athlete_id=l.athlete_id AND d.version_id=l.origin_version_id AND d.item_key=l.item_key AND d.item_id=l.item_id AND d.event_id=l.origin_event_id
 JOIN public.restore_suppression_event e ON e.athlete_id=d.athlete_id AND e.event_id=d.event_id AND e.record_version=4 AND e.kind='race_event_deleted'
 WHERE l.athlete_id=t AND l.plan_id=p AND l.version_id=v AND l.item_key=sha256(convert_to(i,'UTF8')) AND l.item_id=i
  AND NOT EXISTS(SELECT 1 FROM public.nutrition_race_item_disconnection x WHERE x.athlete_id=t AND x.version_id=v AND x.item_key=l.item_key AND x.item_id=i)
$$;
REVOKE ALL ON FUNCTION public.nutrition_v4_origin(text,uuid,uuid,text) FROM PUBLIC;
CREATE FUNCTION public.read_nutrition_disconnection_origin(plan uuid,version uuid,item text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); BEGIN
 PERFORM public.manual_review_owner(); PERFORM public.assert_manual_review_global_lock(); PERFORM public.assert_manual_review_lifecycle_lock(tenant);
 IF tenant IS NULL OR item IS NULL OR length(item)=0 OR item<>btrim(item) OR octet_length(item)>524288 THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_INVALID_IDENTITY'; END IF;
 RETURN EXISTS(SELECT 1 FROM public.nutrition_plan_version v WHERE v.athlete_id=tenant AND v.plan_id=$1 AND v.version_id=$2
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.record_json->'items') i WHERE i->>'id'=$3 AND i->'anchor'='{"kind":"disconnected","entity":"race"}'::jsonb)
  AND EXISTS(SELECT 1 FROM public.nutrition_v4_origin(tenant,$1,$2,$3)));
END $$;
REVOKE ALL ON FUNCTION public.read_nutrition_disconnection_origin(uuid,uuid,text) FROM PUBLIC;

-- Same three-offset candidate algorithm as nutrition-calendar.localInstant.
CREATE FUNCTION public.nutrition_v4_local_instant(d date,t time,z text) RETURNS timestamptz LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH target AS (SELECT (d+t) AT TIME ZONE 'UTC' utc,d+t wall), offsets AS (
 SELECT DISTINCT (sample AT TIME ZONE z)-(sample AT TIME ZONE 'UTC') delta FROM target, LATERAL unnest(ARRAY[utc-interval '1 day',utc,utc+interval '1 day']) sample),
 matches AS (SELECT DISTINCT utc-delta candidate FROM target,offsets WHERE (utc-delta) AT TIME ZONE z=wall)
 SELECT CASE WHEN count(*)=1 THEN max(candidate) END FROM matches
$$;
REVOKE ALL ON FUNCTION public.nutrition_v4_local_instant(date,time,text) FROM PUBLIC;

-- V4 adds multi-revision pins; old1/2/3 validator remains byte-for-byte in108.
-- Opaque item IDs use the existing ECMAScript UTF-16 code-unit key.
-- PostgreSQL UTF-8 C collation orders supplementary characters differently.
ALTER FUNCTION public.assert_nutrition_disconnect_body(jsonb) RENAME TO assert_nutrition_disconnect_body_before_lineage;
CREATE FUNCTION public.assert_nutrition_disconnect_body(b jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE entry jsonb; prior_pin jsonb; key text; used text[]:='{}'; ids text[]:='{}'; last_id text;
BEGIN
 IF b->>'schemaVersion' IS DISTINCT FROM '4' THEN PERFORM public.assert_nutrition_disconnect_body_before_lineage(b); RETURN; END IF;
 IF octet_length(b::text)>524288 OR NOT public.nutrition_copy_structural_codec(b,public.nutrition_v4_wire_schema('version'))
 THEN RAISE EXCEPTION 'NUTRITION_V4_BODY_INVALID'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(b->'items'))<>(SELECT count(DISTINCT i->>'id') FROM jsonb_array_elements(b->'items') i)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE i->>'planVersionId' IS DISTINCT FROM b->>'versionId'
   OR (jsonb_array_length(i->'foods')=0 AND jsonb_array_length(i->'targets')=0 AND btrim(i->>'instructions')=''))
 THEN RAISE EXCEPTION 'NUTRITION_V4_ITEM_INVALID'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(b->'raceTimingPins') LOOP
  IF prior_pin IS NOT NULL AND ((prior_pin->>'eventId')>(entry->>'eventId') OR (prior_pin->>'eventId'=entry->>'eventId' AND (prior_pin->>'eventRevision')::int>=(entry->>'eventRevision')::int)) THEN RAISE EXCEPTION 'NUTRITION_V4_PIN_ORDER'; END IF;
  prior_pin:=entry;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(b->'itemRaceTimingBindings') LOOP
  IF last_id IS NOT NULL AND public.nutrition_copy_utf16_key(last_id)>=public.nutrition_copy_utf16_key(entry->>'itemId') THEN RAISE EXCEPTION 'NUTRITION_V4_BINDING_ORDER'; END IF; last_id:=entry->>'itemId';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE i->>'id'=entry->>'itemId' AND i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race') THEN RAISE EXCEPTION 'NUTRITION_V4_BINDING_MEMBER'; END IF;
  ids:=array_append(ids,last_id);
  IF entry->'binding'->>'state'='captured' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE i->>'id'=last_id AND i->'anchor'->>'entityId'=entry->'binding'->>'eventId')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'raceTimingPins') p WHERE p->>'eventId'=entry->'binding'->>'eventId' AND p->'eventRevision'=entry->'binding'->'eventRevision') THEN RAISE EXCEPTION 'NUTRITION_V4_PIN_MEMBER'; END IF;
   used:=array_append(used,(entry->'binding'->>'eventId')||':'||(entry->'binding'->>'eventRevision'));
  ELSIF entry->'binding'->>'priorItemId' IS DISTINCT FROM last_id THEN RAISE EXCEPTION 'NUTRITION_V4_LEGACY_IDENTITY'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND NOT i->>'id'=ANY(ids))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'raceTimingPins') p WHERE NOT ((p->>'eventId')||':'||(p->>'eventRevision'))=ANY(used)) THEN RAISE EXCEPTION 'NUTRITION_V4_ROSTER_REQUIRED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_nutrition_disconnect_body(jsonb) FROM PUBLIC;
ALTER FUNCTION public.nutrition_redacted_body_v3(jsonb,text[],uuid[]) RENAME TO nutrition_redacted_body_before_lineage;
CREATE FUNCTION public.nutrition_redacted_body_v3(b jsonb,ids text[],events uuid[]) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN b->>'schemaVersion'='4' THEN jsonb_set(public.nutrition_redacted_body_before_lineage(jsonb_set(b,'{schemaVersion}','3'),ids,events),'{schemaVersion}','4')
 ELSE public.nutrition_redacted_body_before_lineage(b,ids,events) END
$$;
REVOKE ALL ON FUNCTION public.nutrition_redacted_body_v3(jsonb,text[],uuid[]) FROM PUBLIC;

CREATE FUNCTION public.guard_nutrition_lineage_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM public.assert_nutrition_v4_caller();
 IF NOT EXISTS(SELECT 1 FROM public.nutrition_v4_commit_seal s WHERE s.athlete_id=NEW.athlete_id AND s.version_id=NEW.version_id AND s.plan_id=NEW.plan_id AND s.prior_version_id=NEW.prior_version_id AND s.caller_role=session_user AND s.owner_xid=txid_current() AND s.expires_at>statement_timestamp())
 THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_COMMIT_PROTOCOL_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_nutrition_lineage_insert() FROM PUBLIC;
CREATE TRIGGER nutrition_lineage_insert BEFORE INSERT ON public.nutrition_race_disconnection_lineage FOR EACH ROW EXECUTE FUNCTION public.guard_nutrition_lineage_insert();
CREATE TRIGGER nutrition_lineage_immutable BEFORE UPDATE OR DELETE ON public.nutrition_race_disconnection_lineage FOR EACH ROW EXECUTE FUNCTION public.guard_nutrition_disconnection_mutation();
CREATE TRIGGER nutrition_lineage_no_truncate BEFORE TRUNCATE ON public.nutrition_race_disconnection_lineage FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation();

-- Successor INSERT guard delegates all historical writes to the exact108 guard.
ALTER FUNCTION public.guard_nutrition_disconnection_insert() RENAME TO guard_nutrition_disconnection_insert_before_lineage;
DROP TRIGGER nutrition_disconnect_insert ON public.nutrition_plan_version;
CREATE FUNCTION public.guard_nutrition_disconnection_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 PERFORM public.manual_review_owner();
 IF NEW.record_json->>'schemaVersion' IS DISTINCT FROM '4' THEN
  PERFORM public.assert_nutrition_disconnect_body(NEW.record_json);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.record_json->'items') i WHERE i->'anchor'->>'kind'='disconnected') THEN RAISE EXCEPTION 'NUTRITION_DISCONNECTED_RESTORE_REQUIRED'; END IF;
 ELSE
  PERFORM public.assert_nutrition_v4_caller(); PERFORM public.assert_nutrition_disconnect_body(NEW.record_json);
  IF NOT EXISTS(SELECT 1 FROM public.nutrition_v4_commit_seal s WHERE s.athlete_id=NEW.athlete_id AND s.version_id=NEW.version_id AND s.plan_id=NEW.plan_id AND s.prior_version_id=NEW.previous_version_id AND s.owner_xid=txid_current() AND s.caller_role=session_user AND s.expires_at>statement_timestamp() AND s.saved_digest=encode(sha256(convert_to(NEW.record_json::text,'UTF8')),'hex')) THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_COMMIT_PROTOCOL_REQUIRED' USING ERRCODE='42501'; END IF;
 END IF;
 IF NEW.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'NUTRITION_DISCONNECT_TENANT_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM public.restore_suppression_event e WHERE e.athlete_id=NEW.athlete_id AND e.record_version=4 AND e.kind='race_event_deleted' AND
  (EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.record_json->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND lower(i->'anchor'->>'entityId')=e.target_id::text)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(NEW.record_json->'raceTimingPins','[]')) p WHERE lower(p->>'eventId')=e.target_id::text))) THEN RAISE EXCEPTION 'NUTRITION_SUPPRESSED_RACE_REENTRY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_nutrition_disconnection_insert() FROM PUBLIC;
CREATE TRIGGER nutrition_disconnect_insert BEFORE INSERT ON public.nutrition_plan_version FOR EACH ROW WHEN(NEW.record_json->>'schemaVersion' IS DISTINCT FROM '4') EXECUTE FUNCTION public.guard_nutrition_disconnection_insert_before_lineage();
CREATE TRIGGER nutrition_disconnect_v4_insert BEFORE INSERT ON public.nutrition_plan_version FOR EACH ROW WHEN(NEW.record_json->>'schemaVersion'='4') EXECUTE FUNCTION public.guard_nutrition_disconnection_insert();

CREATE FUNCTION public.commit_nutrition_plan_v4(plan uuid,expected uuid,request jsonb,saved jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' SET datestyle='ISO,YMD' AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); prior public.nutrition_plan_version%ROWTYPE;
 receipt public.command_receipt%ROWTYPE; app_revision integer; key text; request_digest text; result jsonb;
 command jsonb; nested jsonb; item jsonb; old_item jsonb; bind jsonb; old_bind jsonb; pin jsonb; old_pin jsonb;
 expected_head jsonb; race public.race_event%ROWTYPE; rev public.race_event_revision%ROWTYPE; ancestor record;
 unchanged boolean; reconnect boolean; source_instant timestamptz; linked jsonb; content jsonb;
BEGIN
 PERFORM public.assert_nutrition_v4_caller();
 PERFORM public.manual_review_owner();
 PERFORM pg_advisory_xact_lock_shared(77210,1);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,77206));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 IF tenant IS NULL OR NOT EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id=tenant::uuid) THEN RAISE EXCEPTION 'NUTRITION_V4_ACCOUNT_REQUIRED'; END IF;
 app_revision:=public.require_app_admission_revision(NULL);
 IF jsonb_typeof(request)<>'object' OR octet_length(request::text)>524288 OR request->>'operation' IS DISTINCT FROM 'nutrition_plan_save' OR request->'intentSchemaVersion' IS DISTINCT FROM '4'::jsonb THEN RAISE EXCEPTION 'NUTRITION_V4_INTENT_INVALID'; END IF;
 command:=request-ARRAY['operation','intentSchemaVersion','expectedRaceHeads','reconnectItemIds'];
 nested:=jsonb_build_object('schemaVersion',4,'intent',jsonb_build_object('schemaVersion',3,'command',command,'expectedRaceHeads',request->'expectedRaceHeads','reconnectItemIds',request->'reconnectItemIds'));
 IF NOT public.nutrition_copy_structural_codec(nested,public.nutrition_v4_wire_schema('intent')) OR command->>'kind' IS DISTINCT FROM 'update' OR command->'confirmed' IS DISTINCT FROM 'true'::jsonb OR (command->>'planId')::uuid IS DISTINCT FROM plan OR (command->>'expectedHeadVersionId')::uuid IS DISTINCT FROM expected THEN RAISE EXCEPTION 'NUTRITION_V4_INTENT_INVALID'; END IF;
 key:='nutrition-plan:'||(command->>'idempotencyKey');
 request_digest:=encode(sha256(convert_to(request::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM public.command_receipt WHERE athlete_id=tenant AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.request IS DISTINCT FROM jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1','requestDigest',request_digest) THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  IF receipt.result->>'kind' IS DISTINCT FROM 'nutrition_plan' OR NOT EXISTS(SELECT 1 FROM public.nutrition_plan_version v WHERE v.athlete_id=tenant AND v.plan_id=plan AND v.version_id=(receipt.result->>'versionId')::uuid AND v.approval_id=(receipt.result->>'approvalId')::uuid) THEN RAISE EXCEPTION 'NUTRITION_V4_RECEIPT_INVALID'; END IF;
  RETURN receipt.result;
 END IF;
 SELECT v.* INTO prior FROM public.nutrition_plan_head head JOIN public.nutrition_plan_version v ON v.athlete_id=head.athlete_id AND v.plan_id=head.plan_id AND v.version_id=head.version_id AND v.version=head.version WHERE head.athlete_id=tenant AND head.plan_id=plan FOR UPDATE OF head,v;
 IF NOT FOUND OR prior.version_id<>expected OR prior.version>=2147483646 OR octet_length(prior.record_json::text)>524288 THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 PERFORM public.assert_nutrition_disconnect_body(prior.record_json);
 PERFORM public.assert_nutrition_disconnect_body(saved);
 IF saved->>'schemaVersion' IS DISTINCT FROM '4' OR saved->>'planId' IS DISTINCT FROM plan::text OR saved->>'previousVersionId' IS DISTINCT FROM expected::text OR (saved->>'version')::int<>prior.version+1 OR (saved->>'versionId')::uuid=expected
  OR (saved-ARRAY['schemaVersion','planId','versionId','version','previousVersionId','approvalId','approvedAt','raceTimingPins','itemRaceTimingBindings','items']) IS DISTINCT FROM (command->'draft')-'items'
  OR (SELECT coalesce(jsonb_agg(i-'planVersionId' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(saved->'items') WITH ORDINALITY x(i,n)) IS DISTINCT FROM command->'draft'->'items'
  OR (saved->>'approvedAt')::timestamptz>clock_timestamp() OR (saved->>'approvedAt')::timestamptz<statement_timestamp()-interval '30 seconds'
 THEN RAISE EXCEPTION 'NUTRITION_V4_SAVED_IDENTITY'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements_text(request->'reconnectItemIds'))<>(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(request->'reconnectItemIds') x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(request->'reconnectItemIds') x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'items') i WHERE i->>'id'=x AND i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race'))
  OR (SELECT coalesce(jsonb_agg(x ORDER BY public.nutrition_copy_utf16_key(x)),'[]'::jsonb) FROM jsonb_array_elements_text(request->'reconnectItemIds') x) IS DISTINCT FROM request->'reconnectItemIds'
 THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_MEMBERSHIP'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(request->'expectedRaceHeads'))<>(SELECT count(DISTINCT (x->>'eventId')::uuid) FROM jsonb_array_elements(request->'expectedRaceHeads') x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request->'expectedRaceHeads') h WHERE h->>'eventId'=i->'anchor'->>'entityId'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(request->'expectedRaceHeads') h WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND i->'anchor'->>'entityId'=h->>'eventId'))
 THEN RAISE EXCEPTION 'NUTRITION_V4_RACE_ROSTER'; END IF;
 FOR expected_head IN SELECT value FROM jsonb_array_elements(request->'expectedRaceHeads') LOOP
  SELECT * INTO race FROM public.race_event WHERE athlete_id=tenant AND id=(expected_head->>'eventId')::uuid AND NOT deleted;
  IF NOT FOUND OR race.revision<>(expected_head->>'revision')::int THEN RAISE EXCEPTION 'RACE_TIMING_STALE'; END IF;
 END LOOP;
 IF (saved->>'linkedTrainingPlanVersionId') IS NOT NULL THEN
  SELECT draft INTO linked FROM public.plan_snapshot WHERE athlete_id=tenant AND id=(saved->>'linkedTrainingPlanVersionId')::uuid;
  IF NOT FOUND OR octet_length(linked::text)+octet_length(prior.record_json::text)+octet_length(saved::text)>4194304 THEN RAISE EXCEPTION 'SESSION_LINK_INVALID'; END IF;
 END IF;
 INSERT INTO public.nutrition_v4_commit_seal VALUES(tenant,(saved->>'versionId')::uuid,plan,expected,session_user,txid_current(),app_revision,key,request_digest,encode(sha256(convert_to(saved::text,'UTF8')),'hex'),statement_timestamp()+interval '30 seconds');
 FOR item IN SELECT value FROM jsonb_array_elements(saved->'items') LOOP
  SELECT i INTO old_item FROM jsonb_array_elements(prior.record_json->'items') i WHERE i->>'id'=item->>'id';
  unchanged:=old_item IS NOT NULL AND old_item-'planVersionId'=item-'planVersionId' AND prior.record_json->'period'=saved->'period' AND prior.record_json->'timezone'=saved->'timezone' AND prior.record_json->'linkedTrainingPlanVersionId'=saved->'linkedTrainingPlanVersionId';
  reconnect:=request->'reconnectItemIds' @> jsonb_build_array(item->>'id');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(item->'foods') f WHERE f->>'foodVersionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.food_definition_version v WHERE v.athlete_id=tenant AND v.version_id=(f->>'foodVersionId')::uuid)) THEN RAISE EXCEPTION 'FOOD_VERSION_NOT_FOUND'; END IF;
  IF item->'anchor'->>'kind'='relative' AND item->'anchor'->>'entity'='session' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(linked->'sessions') s WHERE s->>'id'=item->'anchor'->>'entityId') THEN RAISE EXCEPTION 'SESSION_LINK_INVALID'; END IF;
  IF item->'anchor'->>'kind'='disconnected' OR old_item->'anchor'->>'kind'='disconnected' THEN
   SELECT * INTO ancestor FROM public.nutrition_v4_origin(tenant,plan,expected,item->>'id');
   IF NOT FOUND OR old_item->'anchor' IS DISTINCT FROM '{"kind":"disconnected","entity":"race"}'::jsonb THEN RAISE EXCEPTION 'NUTRITION_V4_ORIGIN_REQUIRED'; END IF;
   IF item->'anchor'->>'kind'='disconnected' AND reconnect THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_MEMBERSHIP'; END IF;
   IF item->'anchor'->>'kind'<>'disconnected' AND (NOT reconnect OR item->'anchor'->>'entity'<>'race' OR item->'anchor'->>'kind'<>'relative') THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_REQUIRED'; END IF;
   INSERT INTO public.nutrition_race_disconnection_lineage VALUES(tenant,plan,(saved->>'versionId')::uuid,prior.version+1,expected,prior.version,sha256(convert_to(item->>'id','UTF8')),item->>'id',ancestor.origin_version_id,ancestor.origin_event_id,CASE WHEN item->'anchor'->>'kind'='disconnected' THEN 'retained' ELSE 'reconnected' END,'postgres-row-jsonb-utc-v1',encode(sha256(convert_to(to_jsonb(prior)::text,'UTF8')),'hex'));
  ELSIF reconnect THEN RAISE EXCEPTION 'NUTRITION_V4_RECONNECT_MEMBERSHIP';
  ELSIF EXISTS(SELECT 1 FROM public.nutrition_race_disconnection_lineage l WHERE l.athlete_id=tenant AND l.version_id=expected AND l.item_key=sha256(convert_to(item->>'id','UTF8')) AND l.item_id=item->>'id') THEN
   INSERT INTO public.nutrition_race_disconnection_lineage SELECT tenant,plan,(saved->>'versionId')::uuid,prior.version+1,expected,prior.version,l.item_key,l.item_id,l.origin_version_id,l.origin_event_id,'carried','postgres-row-jsonb-utc-v1',encode(sha256(convert_to(to_jsonb(prior)::text,'UTF8')),'hex') FROM public.nutrition_race_disconnection_lineage l WHERE l.athlete_id=tenant AND l.version_id=expected AND l.item_key=sha256(convert_to(item->>'id','UTF8')) AND l.item_id=item->>'id';
  END IF;
  IF item->'anchor'->>'kind'='relative' AND item->'anchor'->>'entity'='race' THEN
   SELECT x INTO bind FROM jsonb_array_elements(saved->'itemRaceTimingBindings') x WHERE x->>'itemId'=item->>'id';
   SELECT x INTO old_bind FROM jsonb_array_elements(coalesce(prior.record_json->'itemRaceTimingBindings','[]')) x WHERE x->>'itemId'=item->>'id';
   IF unchanged AND NOT reconnect THEN
    IF old_bind IS NOT NULL THEN
     IF bind IS DISTINCT FROM old_bind THEN RAISE EXCEPTION 'NUTRITION_V4_UNTOUCHED_BINDING'; END IF;
     IF bind->'binding'->>'state'='captured' THEN
      SELECT x INTO pin FROM jsonb_array_elements(saved->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';
      SELECT x INTO old_pin FROM jsonb_array_elements(prior.record_json->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';
      IF pin IS DISTINCT FROM old_pin THEN RAISE EXCEPTION 'NUTRITION_V4_UNTOUCHED_PIN'; END IF;
     END IF;
    ELSE
     IF bind->'binding' IS DISTINCT FROM jsonb_build_object('state','legacy_unpinned','priorNutritionVersionId',expected,'priorItemId',item->>'id','priorAnchorDigest',encode(sha256(convert_to(public.nutrition_copy_canonical_json(jsonb_build_object('domain','nutrition-anchor-canonical-v1','anchor',old_item->'anchor')),'UTF8')),'hex')) THEN RAISE EXCEPTION 'NUTRITION_V4_LEGACY_PRIOR_REQUIRED'; END IF;
    END IF;
   ELSE
    IF bind->'binding'->>'state' IS DISTINCT FROM 'captured' THEN RAISE EXCEPTION 'NUTRITION_V4_CAPTURE_REQUIRED'; END IF;
    SELECT x INTO pin FROM jsonb_array_elements(saved->'raceTimingPins') x WHERE x->>'eventId'=bind->'binding'->>'eventId' AND x->'eventRevision'=bind->'binding'->'eventRevision';
    SELECT * INTO race FROM public.race_event WHERE athlete_id=tenant AND id=(pin->>'eventId')::uuid AND NOT deleted;
    SELECT * INTO rev FROM public.race_event_revision WHERE athlete_id=tenant AND entity_id=race.id AND revision=race.revision;
    source_instant:=public.nutrition_v4_local_instant((race.values_json->>'localDate')::date,(race.values_json->>'localStartTime')::time,race.values_json->>'timezone');
    IF race.id IS NULL OR rev.entity_id IS NULL OR race.revision<>(pin->>'eventRevision')::int OR rev.values_json IS DISTINCT FROM race.values_json
     OR pin->>'localDate' IS DISTINCT FROM race.values_json->>'localDate' OR pin->>'localStartTime' IS DISTINCT FROM race.values_json->>'localStartTime' OR pin->>'timezone' IS DISTINCT FROM race.values_json->>'timezone'
     OR pin->>'sourceDigest' IS DISTINCT FROM encode(sha256(convert_to(public.nutrition_copy_canonical_json(jsonb_build_object('domain','race-event-values-canonical-v1','namespace','race-event-revision','eventId',race.id,'eventRevision',race.revision,'values',race.values_json)),'UTF8')),'hex')
     OR source_instant IS NULL OR pin->'start'->>'state' IS DISTINCT FROM 'known' OR (pin->'start'->>'instant')::timestamptz IS DISTINCT FROM source_instant
     OR pin->'end' IS DISTINCT FROM '{"state":"unknown","reason":"race_end_not_recorded"}'::jsonb OR item->'anchor'->>'point'<>'start'
    THEN RAISE EXCEPTION 'NUTRITION_V4_SOURCE_CAPTURE_INVALID'; END IF;
   END IF;
  END IF;
 END LOOP;
 INSERT INTO public.nutrition_plan_version VALUES(tenant,plan,(saved->>'versionId')::uuid,prior.version+1,expected,prior.version,(saved->'period'->>'from')::date,(saved->'period'->>'toInclusive')::date,(saved->>'linkedTrainingPlanVersionId')::uuid,(saved->>'approvalId')::uuid,(saved->>'approvedAt')::timestamptz,saved);
 UPDATE public.nutrition_plan_head SET version=prior.version+1,version_id=(saved->>'versionId')::uuid WHERE athlete_id=tenant AND plan_id=$1 AND version_id=expected;
 INSERT INTO public.nutrition_plan_history VALUES(tenant,plan,(saved->>'versionId')::uuid,(saved->>'approvalId')::uuid,'user_approved',(saved->>'approvedAt')::timestamptz);
 result:=jsonb_build_object('receiptVersion',3,'outcome','committed','kind','nutrition_plan','planId',plan,'versionId',saved->'versionId','version',prior.version+1,'approvalId',saved->'approvalId');
 INSERT INTO public.command_receipt VALUES(tenant,key,jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1','requestDigest',request_digest),result);
 INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload) VALUES(tenant,gen_random_uuid(),key,'nutrition.plan_changed',jsonb_build_object('planId',plan,'versionId',saved->'versionId','approvalId',saved->'approvalId'));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.guard_nutrition_v4_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); s public.nutrition_v4_commit_seal; v public.nutrition_plan_version;
BEGIN
 PERFORM public.assert_nutrition_v4_caller();
 IF TG_OP<>'INSERT' OR NEW.athlete_id IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'NUTRITION_V4_RECEIPT_IMMUTABLE'; END IF;
 SELECT * INTO s FROM public.nutrition_v4_commit_seal WHERE athlete_id=tenant AND receipt_key=NEW.idempotency_key AND caller_role=session_user AND owner_xid=txid_current() AND expires_at>statement_timestamp();
 SELECT * INTO v FROM public.nutrition_plan_version WHERE athlete_id=tenant AND version_id=s.version_id AND plan_id=s.plan_id;
 IF s.version_id IS NULL OR v.version_id IS NULL OR NEW.request IS DISTINCT FROM jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1','requestDigest',s.request_digest)
  OR NEW.result IS DISTINCT FROM jsonb_build_object('receiptVersion',3,'outcome','committed','kind','nutrition_plan','planId',v.plan_id,'versionId',v.version_id,'version',v.version,'approvalId',v.approval_id)
 THEN RAISE EXCEPTION 'NUTRITION_V4_RECEIPT_PROTOCOL_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_nutrition_v4_receipt() FROM PUBLIC;
DROP TRIGGER nutrition_save_receipt_copy ON public.command_receipt;
CREATE TRIGGER nutrition_save_receipt_copy BEFORE INSERT OR UPDATE ON public.command_receipt FOR EACH ROW
 WHEN(NEW.request->>'receiptVersion' IS DISTINCT FROM '3') EXECUTE FUNCTION public.guard_nutrition_save_receipt_copy();
CREATE TRIGGER nutrition_v4_receipt_guard BEFORE INSERT OR UPDATE ON public.command_receipt FOR EACH ROW
 WHEN(NEW.request->>'receiptVersion'='3') EXECUTE FUNCTION public.guard_nutrition_v4_receipt();

CREATE FUNCTION public.verify_nutrition_v4_commit_final() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE v public.nutrition_plan_version; prior public.nutrition_plan_version; l public.nutrition_race_disconnection_lineage; item jsonb; old_item jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=NEW.athlete_id) THEN RETURN NEW; END IF;
 SELECT * INTO v FROM public.nutrition_plan_version WHERE athlete_id=NEW.athlete_id AND version_id=NEW.version_id AND plan_id=NEW.plan_id;
 SELECT * INTO prior FROM public.nutrition_plan_version WHERE athlete_id=NEW.athlete_id AND version_id=NEW.prior_version_id AND plan_id=NEW.plan_id;
 IF NEW.owner_xid<>txid_current() OR NEW.expires_at<=clock_timestamp() OR public.require_app_admission_revision(NEW.app_revision)<>NEW.app_revision OR v.version_id IS NULL OR prior.version_id IS NULL OR v.previous_version_id<>prior.version_id OR v.previous_version<>prior.version OR v.version<>prior.version+1
  OR encode(sha256(convert_to(v.record_json::text,'UTF8')),'hex') IS DISTINCT FROM NEW.saved_digest
  OR NOT EXISTS(SELECT 1 FROM public.nutrition_plan_head h WHERE h.athlete_id=v.athlete_id AND h.plan_id=v.plan_id AND h.version_id=v.version_id AND h.version=v.version)
  OR NOT EXISTS(SELECT 1 FROM public.nutrition_plan_history h WHERE h.athlete_id=v.athlete_id AND h.plan_id=v.plan_id AND h.version_id=v.version_id AND h.approval_id=v.approval_id AND h.action='user_approved')
  OR NOT EXISTS(SELECT 1 FROM public.command_receipt r WHERE r.athlete_id=v.athlete_id AND r.idempotency_key=NEW.receipt_key AND r.request=jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1','requestDigest',NEW.request_digest) AND r.result=jsonb_build_object('receiptVersion',3,'outcome','committed','kind','nutrition_plan','planId',v.plan_id,'versionId',v.version_id,'version',v.version,'approvalId',v.approval_id))
  OR NOT EXISTS(SELECT 1 FROM public.outbox o WHERE o.athlete_id=v.athlete_id AND o.idempotency_key=NEW.receipt_key AND o.topic='nutrition.plan_changed' AND o.payload=jsonb_build_object('planId',v.plan_id,'versionId',v.version_id,'approvalId',v.approval_id))
 THEN RAISE EXCEPTION 'NUTRITION_V4_ATOMIC_CORRESPONDENCE_REQUIRED' USING ERRCODE='42501'; END IF;
 FOR l IN SELECT * FROM public.nutrition_race_disconnection_lineage WHERE athlete_id=v.athlete_id AND version_id=v.version_id LOOP
  SELECT i INTO item FROM jsonb_array_elements(v.record_json->'items') i WHERE i->>'id'=l.item_id;
  SELECT i INTO old_item FROM jsonb_array_elements(prior.record_json->'items') i WHERE i->>'id'=l.item_id;
  IF l.plan_id<>v.plan_id OR l.prior_version_id<>prior.version_id OR l.prior_version<>prior.version OR l.version<>v.version OR l.item_key<>sha256(convert_to(l.item_id,'UTF8')) OR item IS NULL OR old_item IS NULL
   OR l.prior_row_digest<>encode(sha256(convert_to(to_jsonb(prior)::text,'UTF8')),'hex')
   OR NOT EXISTS(SELECT 1 FROM public.nutrition_v4_origin(v.athlete_id,v.plan_id,prior.version_id,l.item_id) a WHERE a.origin_version_id=l.origin_version_id AND a.origin_event_id=l.origin_event_id)
   OR (l.disposition='retained' AND (item->'anchor'<>'{"kind":"disconnected","entity":"race"}'::jsonb OR old_item->'anchor'<>'{"kind":"disconnected","entity":"race"}'::jsonb))
   OR (l.disposition='reconnected' AND (old_item->'anchor'<>'{"kind":"disconnected","entity":"race"}'::jsonb OR item->'anchor'->>'kind'<>'relative' OR item->'anchor'->>'entity'<>'race' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.record_json->'itemRaceTimingBindings') b WHERE b->>'itemId'=l.item_id AND b->'binding'->>'state'='captured')))
   OR (l.disposition='carried' AND NOT EXISTS(SELECT 1 FROM public.nutrition_race_disconnection_lineage p WHERE p.athlete_id=v.athlete_id AND p.version_id=prior.version_id AND p.item_id=l.item_id AND p.item_key=l.item_key AND p.origin_event_id=l.origin_event_id AND p.origin_version_id=l.origin_version_id))
  THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_CORRESPONDENCE_REQUIRED' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v.record_json->'items') i WHERE i->'anchor'->>'kind'='disconnected' AND NOT EXISTS(SELECT 1 FROM public.nutrition_race_disconnection_lineage d WHERE d.athlete_id=v.athlete_id AND d.version_id=v.version_id AND d.item_id=i->>'id' AND d.item_key=sha256(convert_to(i->>'id','UTF8')) AND d.disposition='retained')) THEN RAISE EXCEPTION 'NUTRITION_LINEAGE_ROSTER_REQUIRED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.verify_nutrition_v4_commit_final() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER nutrition_v4_commit_final AFTER INSERT ON public.nutrition_v4_commit_seal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_nutrition_v4_commit_final();

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_nutrition_lineage;
REVOKE ALL ON FUNCTION public.erase_account_before_nutrition_lineage(text) FROM PUBLIC;
DO $$ DECLARE g record; BEGIN FOR g IN SELECT DISTINCT p.grantee FROM information_schema.routine_privileges p WHERE p.specific_schema='public' AND p.routine_name='erase_account_before_nutrition_lineage' AND p.grantee<>current_user AND p.grantee<>'PUBLIC' LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_nutrition_lineage(text) FROM %I',g.grantee); END LOOP; END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE stamp timestamptz; BEGIN
 stamp:=public.erase_account_before_nutrition_lineage($1);
 DELETE FROM public.nutrition_race_disconnection_lineage WHERE athlete_id=$1;
 DELETE FROM public.nutrition_v4_commit_seal WHERE athlete_id=$1;
 RETURN stamp;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- Exact source codec successor recognizes authentic descendant origin; no text search.
CREATE OR REPLACE FUNCTION public.nutrition_copy_manifest_related(tenant text,candidate uuid,manifest jsonb,target uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE source record; item_ref jsonb; count_expected integer; count_matched integer; largest bigint; total bigint; bodies jsonb; related boolean:=false;
BEGIN
 count_expected:=jsonb_array_length(manifest->'nutritionVersions');
 -- Preflight in one MVCC command. No record bodies cross this boundary first.
 WITH requested AS MATERIALIZED (SELECT (ref->>'planId')::uuid plan_id,(ref->>'versionId')::uuid version_id FROM jsonb_array_elements(manifest->'nutritionVersions') ref),
 sizes AS MATERIALIZED (SELECT count(*) matched,coalesce(max(octet_length(v.record_json::text)),0) largest,coalesce(sum(octet_length(jsonb_build_object('athlete_id',v.athlete_id,'plan_id',v.plan_id,'version_id',v.version_id,'record_json',v.record_json)::text)),0)+2*count(*)+2 total FROM requested r JOIN public.nutrition_plan_version v ON v.athlete_id=tenant AND v.plan_id=r.plan_id AND v.version_id=r.version_id)
 SELECT sizes.matched,sizes.largest,sizes.total,CASE WHEN sizes.matched=count_expected AND sizes.largest<=524288 AND sizes.total<=4194304 THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('plan_id',v.plan_id,'version_id',v.version_id,'record_json',v.record_json) ORDER BY v.plan_id,v.version_id),'[]'::jsonb) FROM requested r JOIN public.nutrition_plan_version v ON v.athlete_id=tenant AND v.plan_id=r.plan_id AND v.version_id=r.version_id) ELSE NULL END
 INTO count_matched,largest,total,bodies FROM sizes;
 IF bodies IS NULL THEN RAISE EXCEPTION 'NUTRITION_COPY_SOURCE_UNAVAILABLE:%',candidate; END IF;
 FOR source IN SELECT (value->>'plan_id')::uuid plan_id,(value->>'version_id')::uuid version_id,value->'record_json' record_json FROM jsonb_array_elements(bodies) LOOP
  PERFORM public.assert_nutrition_disconnect_body(source.record_json);
  IF source.record_json->>'planId' IS DISTINCT FROM source.plan_id::text OR source.record_json->>'versionId' IS DISTINCT FROM source.version_id::text THEN RAISE EXCEPTION 'NUTRITION_COPY_SOURCE_IDENTITY:%',candidate; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source.record_json->'items') i WHERE i->'anchor'->>'kind'='disconnected' AND NOT EXISTS(SELECT 1 FROM public.nutrition_race_item_disconnection d JOIN public.restore_suppression_event e ON e.event_id=d.event_id AND e.athlete_id=d.athlete_id AND e.record_version=4 AND e.kind='race_event_deleted' WHERE d.athlete_id=tenant AND d.version_id=source.version_id AND d.item_key=sha256(convert_to(i->>'id','UTF8')) AND d.item_id=i->>'id') AND NOT EXISTS(SELECT 1 FROM public.nutrition_v4_origin(tenant,source.plan_id,source.version_id,i->>'id'))) THEN RAISE EXCEPTION 'NUTRITION_COPY_SOURCE_MARKER_REQUIRED:%',candidate; END IF;
  FOR item_ref IN SELECT value FROM jsonb_array_elements(manifest->'nutritionItemRefs') WHERE (value->>'planId')::uuid=source.plan_id AND (value->>'versionId')::uuid=source.version_id LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source.record_json->'items') i WHERE i->>'id'=item_ref->>'itemId') THEN RAISE EXCEPTION 'NUTRITION_COPY_SOURCE_ITEM:%',candidate; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source.record_json->'items') i WHERE i->'anchor'->>'kind'='relative' AND i->'anchor'->>'entity'='race' AND (i->'anchor'->>'entityId')::uuid=target)
   OR EXISTS(SELECT 1 FROM public.nutrition_race_item_disconnection d JOIN public.restore_suppression_event e ON e.event_id=d.event_id AND e.athlete_id=d.athlete_id AND e.record_version=4 AND e.kind='race_event_deleted' WHERE d.athlete_id=tenant AND d.version_id=source.version_id AND e.target_id=target)
  THEN related:=true; END IF;
 END LOOP;
 -- UUID equality, not substring matching. Other-tenant/missing source is unknown.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'races') r WHERE NOT EXISTS(SELECT 1 FROM public.race_event e WHERE e.athlete_id=tenant AND e.id=(r->>'eventId')::uuid)) THEN RAISE EXCEPTION 'NUTRITION_COPY_RACE_OWNER:%',candidate; END IF;
 RETURN related OR manifest->'races' @> jsonb_build_array(jsonb_build_object('namespace','race-event','eventId',target));
END $$;
