-- Validated records are separate from untrusted analysis output and never apply a plan.
CREATE TABLE coaching_decision (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 id uuid NOT NULL, run_id uuid NOT NULL,
 body jsonb, purged_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id), UNIQUE(athlete_id,run_id),
 FOREIGN KEY(athlete_id,run_id) REFERENCES coaching_run(athlete_id,id),
 CHECK ((body IS NOT NULL AND jsonb_typeof(body)='object'
   AND octet_length(body::text)<=65536 AND purged_reason IS NULL
   OR body IS NULL AND purged_reason IN ('source_deleted','consent_withdrawn')) IS TRUE)
);
CREATE TABLE coaching_proposal (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 id uuid NOT NULL, decision_id uuid NOT NULL,
 body jsonb, purged_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id), UNIQUE(athlete_id,decision_id,id),
 FOREIGN KEY(athlete_id,decision_id) REFERENCES coaching_decision(athlete_id,id),
 CHECK ((body IS NOT NULL AND jsonb_typeof(body)='object'
   AND octet_length(body::text)<=65536 AND purged_reason IS NULL
   OR body IS NULL AND purged_reason IN ('source_deleted','consent_withdrawn')) IS TRUE)
);
CREATE TABLE coaching_candidate (
 athlete_id text NOT NULL CHECK(length(athlete_id) BETWEEN 1 AND 200),
 id uuid NOT NULL, decision_id uuid NOT NULL, proposal_id uuid NOT NULL,
 parent_candidate_id uuid,
 digest text, body jsonb, purged_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(athlete_id,id),
 UNIQUE(athlete_id,decision_id,id),
 FOREIGN KEY(athlete_id,decision_id,proposal_id)
  REFERENCES coaching_proposal(athlete_id,decision_id,id),
 FOREIGN KEY(athlete_id,decision_id,parent_candidate_id)
  REFERENCES coaching_candidate(athlete_id,decision_id,id),
 CHECK (parent_candidate_id IS DISTINCT FROM id),
 CHECK ((body IS NOT NULL AND jsonb_typeof(body)='object'
   AND octet_length(body::text)<=4194304 AND purged_reason IS NULL
   AND digest ~ '^[0-9a-f]{64}$'
   OR body IS NULL AND digest IS NULL
    AND purged_reason IN ('source_deleted','consent_withdrawn')) IS TRUE)
);
CREATE INDEX coaching_proposal_decision_page
 ON coaching_proposal(athlete_id,decision_id,created_at DESC,id);
CREATE INDEX coaching_candidate_proposal_page
 ON coaching_candidate(athlete_id,proposal_id,created_at DESC,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['coaching_decision','coaching_proposal','coaching_candidate'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',t);
 END LOOP;
END $$;

-- Only the owner-run deletion/withdrawal trigger may redact, and only account erasure may delete.
CREATE FUNCTION guard_coaching_candidate_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.body IS NOT NULL AND NEW.body IS NULL
   AND NEW.purged_reason IN ('source_deleted','consent_withdrawn')
   AND (to_jsonb(NEW)-'body'-'purged_reason'-'digest')
      =(to_jsonb(OLD)-'body'-'purged_reason'-'digest')
   AND (TG_TABLE_NAME<>'coaching_candidate' OR to_jsonb(NEW)->'digest'='null'::jsonb)
  THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_COACHING_CANDIDATE_RECORD';
END $$;
REVOKE ALL ON FUNCTION guard_coaching_candidate_record() FROM PUBLIC;
CREATE TRIGGER coaching_decision_immutable BEFORE UPDATE OR DELETE ON coaching_decision
 FOR EACH ROW EXECUTE FUNCTION guard_coaching_candidate_record();
CREATE TRIGGER coaching_proposal_immutable BEFORE UPDATE OR DELETE ON coaching_proposal
 FOR EACH ROW EXECUTE FUNCTION guard_coaching_candidate_record();
CREATE TRIGGER coaching_candidate_immutable BEFORE UPDATE OR DELETE ON coaching_candidate
 FOR EACH ROW EXECUTE FUNCTION guard_coaching_candidate_record();

-- A multi-row INSERT can satisfy immediate self-FKs while forming a parent cycle.
CREATE FUNCTION reject_coaching_candidate_parent_cycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.parent_candidate_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE chain(id,parent_candidate_id,seen) AS (
   SELECT c.id,c.parent_candidate_id,ARRAY[c.id]
   FROM public.coaching_candidate c
   WHERE c.athlete_id=NEW.athlete_id AND c.decision_id=NEW.decision_id AND c.id=NEW.id
   UNION ALL
   SELECT parent.id,parent.parent_candidate_id,chain.seen||parent.id
   FROM chain JOIN public.coaching_candidate parent
    ON parent.athlete_id=NEW.athlete_id AND parent.decision_id=NEW.decision_id
    AND parent.id=chain.parent_candidate_id
   WHERE NOT parent.id=ANY(chain.seen)
  ) SELECT 1 FROM chain WHERE parent_candidate_id=NEW.id
 ) THEN RAISE EXCEPTION 'COACHING_CANDIDATE_PARENT_CYCLE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reject_coaching_candidate_parent_cycle() FROM PUBLIC;
CREATE TRIGGER coaching_candidate_parent_cycle AFTER INSERT ON coaching_candidate
 FOR EACH ROW EXECUTE FUNCTION reject_coaching_candidate_parent_cycle();

-- Evidence withdrawal and source deletion redact every derived body in one transaction.
CREATE FUNCTION purge_coaching_candidates_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.athlete_id IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
  RAISE EXCEPTION 'COACHING_CANDIDATE_TENANT_MISMATCH';
 END IF;
 IF OLD.body IS NOT NULL AND NEW.body IS NULL
  AND NEW.purged_reason IN ('source_deleted','consent_withdrawn') THEN
  UPDATE public.coaching_candidate c
   SET body=NULL,digest=NULL,purged_reason=NEW.purged_reason
   FROM public.coaching_proposal p,public.coaching_decision d,public.coaching_run r
   WHERE c.athlete_id=OLD.athlete_id AND c.body IS NOT NULL
    AND p.athlete_id=c.athlete_id AND p.id=c.proposal_id
    AND d.athlete_id=p.athlete_id AND d.id=p.decision_id
    AND r.athlete_id=d.athlete_id AND r.id=d.run_id
    AND r.evidence_snapshot_id=OLD.id;
  UPDATE public.coaching_proposal p
   SET body=NULL,purged_reason=NEW.purged_reason
   FROM public.coaching_decision d,public.coaching_run r
   WHERE p.athlete_id=OLD.athlete_id AND p.body IS NOT NULL
    AND d.athlete_id=p.athlete_id AND d.id=p.decision_id
    AND r.athlete_id=d.athlete_id AND r.id=d.run_id
    AND r.evidence_snapshot_id=OLD.id;
  UPDATE public.coaching_decision d
   SET body=NULL,purged_reason=NEW.purged_reason
   FROM public.coaching_run r
   WHERE d.athlete_id=OLD.athlete_id AND d.body IS NOT NULL
    AND r.athlete_id=d.athlete_id AND r.id=d.run_id
    AND r.evidence_snapshot_id=OLD.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION purge_coaching_candidates_evidence() FROM PUBLIC;
CREATE TRIGGER purge_coaching_candidates_after_evidence AFTER UPDATE OF body ON core_evidence_snapshot
 FOR EACH ROW EXECUTE FUNCTION purge_coaching_candidates_evidence();

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_coaching_candidates;
REVOKE ALL ON FUNCTION public.erase_account_before_coaching_candidates(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT pg_get_userbyid(a.grantee) FROM pg_proc p,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.erase_account_before_coaching_candidates(text)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_coaching_candidates(text) FROM %I',role_name);
 END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN
  RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
 DELETE FROM public.coaching_candidate WHERE athlete_id=$1;
 DELETE FROM public.coaching_proposal WHERE athlete_id=$1;
 DELETE FROM public.coaching_decision WHERE athlete_id=$1;
 RETURN public.erase_account_before_coaching_candidates($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
