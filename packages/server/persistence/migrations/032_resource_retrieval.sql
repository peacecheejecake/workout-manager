-- M2-05 adds the derived stores M2-04d deliberately left absent: the passage
-- search index, the retrieval cache, the pinned grounding excerpts handed to a
-- coach run and the stored citations. Every one of them is a derived copy of a
-- reviewed resource version, so every one of them is a deletion target of the
-- existing resource_derived_cleanup manifest. No parallel queue is introduced:
-- the manifest, its lease, its bounded retry and its dead-letter discipline are
-- reused unchanged and only the per-target executor is added.
--
-- resource_version.index_status stays 'not_indexed'. That column is covered by
-- the M2-04a immutability trigger, which rejects every UPDATE on
-- resource_version, so it records the ingestion-time value only. The presence
-- of resource_passage rows for (resource_id, version_id) is the index state of
-- record for retrieval.

-- One bounded excerpt of one pinned resource version. Passages never span two
-- versions, so a version append cannot mix versions in one answer: retrieval
-- requires version_id = resource.current_version_id and simply stops returning
-- a resource until it is indexed again.
CREATE TABLE resource_passage (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  passage_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  first_paragraph_index integer NOT NULL CHECK (first_paragraph_index BETWEEN 0 AND 999),
  last_paragraph_index integer NOT NULL CHECK (last_paragraph_index BETWEEN 0 AND 999),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > 0),
  heading_path jsonb NOT NULL CHECK (
    jsonb_typeof(heading_path) = 'array' AND jsonb_array_length(heading_path) <= 8
    AND octet_length(heading_path::text) <= 2048
  ),
  content text NOT NULL CHECK (octet_length(convert_to(content, 'UTF8')) BETWEEN 1 AND 16384),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  indexed_access_revision integer NOT NULL
    CHECK (indexed_access_revision BETWEEN 1 AND 2147483646),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, passage_id),
  UNIQUE (athlete_id, resource_id, version_id, ordinal),
  FOREIGN KEY (athlete_id, resource_id) REFERENCES resource (athlete_id, id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id, version_id) REFERENCES resource_version (athlete_id, version_id)
    ON DELETE CASCADE,
  CHECK (last_paragraph_index >= first_paragraph_index),
  CHECK (end_offset > start_offset)
);
-- Lexical candidates only. 'simple' applies no stemming, so Korean tokens are
-- matched as written and English is not stemmed either; this is a bounded
-- lexical prefilter and its ts_rank_cd score is not BM25 and not evidence
-- quality. Vector retrieval and rerank are not implemented.
CREATE INDEX resource_passage_lexical ON resource_passage
  USING gin (to_tsvector('simple'::regconfig, content));
CREATE INDEX resource_passage_current ON resource_passage
  (athlete_id, resource_id, version_id, ordinal);

-- Retrieval cache. The key is derived from tenant, corpus version, the whole
-- authorized-set digest and the normalized filters, so any ACL, consent or
-- review change produces a different key. Cached identifiers are still
-- re-authorized on every hit; the cache is never an authorization source.
CREATE TABLE resource_retrieval_cache (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  cache_key text NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  corpus_version integer NOT NULL CHECK (corpus_version BETWEEN 1 AND 1000),
  authorization_digest text NOT NULL CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  passage_ids jsonb NOT NULL CHECK (
    jsonb_typeof(passage_ids) = 'array' AND jsonb_array_length(passage_ids) <= 20
    AND octet_length(passage_ids::text) <= 2048
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, cache_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX resource_retrieval_cache_expiry ON resource_retrieval_cache (expires_at);

-- One pinned retrieval result for one coaching run. The resource-access-v1
-- manifest captured at pin time is stored with it, so approval can revalidate
-- the complete dependency set instead of trusting the stored excerpts.
CREATE TABLE resource_grounding (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  grounding_id uuid NOT NULL,
  run_id uuid NOT NULL,
  query_text text NOT NULL CHECK (octet_length(convert_to(query_text, 'UTF8')) BETWEEN 1 AND 1000),
  excerpt_count integer NOT NULL CHECK (excerpt_count BETWEEN 0 AND 20),
  manifest jsonb NOT NULL CHECK (
    jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 65536
    AND manifest->>'scope' = 'resource-access-v1'
  ),
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, grounding_id),
  UNIQUE (athlete_id, run_id),
  FOREIGN KEY (athlete_id, run_id) REFERENCES coaching_run (athlete_id, id) ON DELETE CASCADE
);

-- Derived text: the excerpt copy that was actually handed to the model. It is
-- a copy, so it is deleted by the derivedData cleanup target, and the foreign
-- key to the index row makes it structurally impossible for the copy to
-- outlive the passage it came from.
CREATE TABLE resource_grounding_excerpt (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  grounding_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  passage_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  access_revision integer NOT NULL CHECK (access_revision BETWEEN 1 AND 2147483646),
  excerpt text NOT NULL CHECK (octet_length(convert_to(excerpt, 'UTF8')) BETWEEN 1 AND 16384),
  PRIMARY KEY (athlete_id, grounding_id, ordinal),
  UNIQUE (athlete_id, grounding_id, passage_id),
  FOREIGN KEY (athlete_id, grounding_id) REFERENCES resource_grounding (athlete_id, grounding_id)
    ON DELETE CASCADE,
  FOREIGN KEY (athlete_id, passage_id) REFERENCES resource_passage (athlete_id, passage_id)
    ON DELETE CASCADE
);

-- A citation stores identity and offsets, never quoted text: the quote is
-- resolved from the passage through the query-time gate on every read. The
-- cascade to resource_passage means a citation can never outlive its excerpt,
-- and re-reading an old answer cannot resurface a deleted excerpt.
CREATE TABLE resource_citation (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  citation_id uuid NOT NULL,
  grounding_id uuid NOT NULL,
  passage_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  claim_index integer NOT NULL CHECK (claim_index BETWEEN 0 AND 49),
  quote_start integer NOT NULL CHECK (quote_start >= 0),
  quote_end integer NOT NULL CHECK (quote_end > 0),
  quote_hash text NOT NULL CHECK (quote_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, citation_id),
  UNIQUE (athlete_id, grounding_id, claim_index, passage_id, quote_start, quote_end),
  FOREIGN KEY (athlete_id, grounding_id) REFERENCES resource_grounding (athlete_id, grounding_id)
    ON DELETE CASCADE,
  FOREIGN KEY (athlete_id, passage_id) REFERENCES resource_passage (athlete_id, passage_id)
    ON DELETE CASCADE,
  CHECK (quote_end > quote_start)
);
CREATE INDEX resource_citation_grounding ON resource_citation
  (athlete_id, grounding_id, claim_index, citation_id);

ALTER TABLE resource_passage ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_passage FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_passage_tenant ON resource_passage
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE resource_retrieval_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_retrieval_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_retrieval_cache_tenant ON resource_retrieval_cache
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE resource_grounding ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_grounding FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_grounding_tenant ON resource_grounding
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE resource_grounding_excerpt ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_grounding_excerpt FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_grounding_excerpt_tenant ON resource_grounding_excerpt
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));
ALTER TABLE resource_citation ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_citation FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_citation_tenant ON resource_citation
  USING (athlete_id = nullif(current_setting('app.athlete_id', true), ''))
  WITH CHECK (athlete_id = nullif(current_setting('app.athlete_id', true), ''));

-- The derived-store executor. It is callable only while the caller still holds
-- a valid lease on the manifest entry it names, so a worker cannot purge an
-- arbitrary tenant's derived data and a lost lease cannot delete anything. The
-- tenant and resource are read from the manifest row, never from the caller.
-- Returning a row count exposes no content.
CREATE FUNCTION public.purge_resource_derived_store(uuid, uuid, text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE tenant text;
DECLARE resource uuid;
DECLARE affected integer := 0;
BEGIN
  SELECT q.athlete_id, q.resource_id INTO tenant, resource
    FROM public.resource_derived_cleanup q
    WHERE q.id = $1 AND q.lease_owner = $2 AND q.completed_at IS NULL
      AND q.lease_until > clock_timestamp();
  IF tenant IS NULL THEN RAISE EXCEPTION 'DERIVED_CLEANUP_LEASE_LOST'; END IF;
  IF $3 = 'derivedData' THEN
    DELETE FROM public.resource_grounding_excerpt
      WHERE athlete_id = tenant AND resource_id = resource;
  ELSIF $3 = 'searchIndex' THEN
    DELETE FROM public.resource_passage WHERE athlete_id = tenant AND resource_id = resource;
  ELSIF $3 = 'cache' THEN
    -- A cached entry names passages from many resources, so a per-resource
    -- purge could leave an entry that still lists a withdrawn excerpt. The
    -- tenant's cache is dropped whole; it is rebuildable by definition.
    DELETE FROM public.resource_retrieval_cache WHERE athlete_id = tenant;
  ELSIF $3 = 'citations' THEN
    DELETE FROM public.resource_citation WHERE athlete_id = tenant AND resource_id = resource;
  ELSE
    RAISE EXCEPTION 'UNKNOWN_DERIVED_TARGET';
  END IF;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.purge_resource_derived_store(uuid, uuid, text) FROM PUBLIC;

-- Account erasure removes the derived stores before the earlier stages drop the
-- resources and coaching runs they point at.
ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_resource_retrieval;
REVOKE ALL ON FUNCTION public.erase_account_before_resource_retrieval(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.erase_account_before_resource_retrieval(text)'::regprocedure
      AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP EXECUTE format(
    'REVOKE ALL ON FUNCTION public.erase_account_before_resource_retrieval(text) FROM %I',
    role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id', true), '')
  THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1, 77206));
  DELETE FROM public.resource_citation WHERE athlete_id = $1;
  DELETE FROM public.resource_grounding_excerpt WHERE athlete_id = $1;
  DELETE FROM public.resource_grounding WHERE athlete_id = $1;
  DELETE FROM public.resource_retrieval_cache WHERE athlete_id = $1;
  DELETE FROM public.resource_passage WHERE athlete_id = $1;
  RETURN public.erase_account_before_resource_retrieval($1);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;

-- Review is pinned to the version it was given for. M2-04d already forbade a
-- version append from PROMOTING review or coach use; carrying an existing
-- `reviewed` flag across a content replacement is a different thing, and it is
-- no longer safe now that the content is indexed and handed to a model. The
-- new column records which version was actually reviewed, and the query-time
-- gate requires it to be the current one, so replacing the body of a reviewed
-- document makes it non-coach-usable until it is explicitly reviewed again.
ALTER TABLE resource ADD COLUMN reviewed_version_id uuid;
-- The backfill is a schema upgrade, not an access command, so the head
-- transition trigger — which requires an access revision bump — is disabled
-- around it. Leaving it enabled makes this migration fail on any existing
-- database that already holds a reviewed row.
ALTER TABLE resource DISABLE TRIGGER resource_head_transition;
-- Conservative on purpose, and fail-closed where the evidence is not decisive.
-- Under M2-04d a reviewed resource kept its flag across a version append, so a
-- newer body may never have been reviewed by anyone; pinning such a row here
-- would promote exactly the unreviewed content this column exists to keep out.
--
-- Two signals are used, in this order:
--   1. A resource with a single version has only one body, so a review of the
--      resource is necessarily a review of that body. No ordering has to be
--      inferred at all, and this is the only fully structural signal the 031
--      schema offers: resource_version carries no access revision, and
--      resource_access_audit records no version-append action, so there is no
--      way to compare the review against the append by revision.
--   2. Otherwise the review must be shown to have happened strictly after the
--      current version existed. M2-04d had no re-review transition — marking an
--      already-reviewed resource reviewed was a no-op — so reviewed_at is the
--      instant of the review that is still in force. A STRICTLY later instant
--      therefore means the review was given while this version was already
--      current. Equal timestamps prove nothing: wall clock alone cannot order
--      "reviewed, then a version was created" against the reverse, so an equal
--      instant stays unpinned.
--
-- Unpinned rows read as "reviewed, but not this version" and keep the coach-use
-- gate closed until the owner reviews the current body. No derived data can
-- exist for them yet: the stores below are created empty by this same
-- migration, so there is nothing to purge and no cleanup manifest to enqueue.
UPDATE resource r SET reviewed_version_id = r.current_version_id
  FROM resource_version v
  WHERE v.athlete_id = r.athlete_id AND v.version_id = r.current_version_id
    AND r.reviewed_state = 'reviewed' AND r.reviewed_at IS NOT NULL
    AND (r.current_version = 1 OR r.reviewed_at > v.created_at);
ALTER TABLE resource ENABLE TRIGGER resource_head_transition;
-- An unreviewed resource never carries a pin. A reviewed one carries the
-- version that was reviewed, or nothing when it predates this column. The
-- CHECK alone cannot express "only the rows this migration left behind may be
-- reviewed without a pin", so the insert trigger below enforces that no new
-- unpinned reviewed row can ever be created; the head transition trigger
-- already covers updates.
ALTER TABLE resource ADD CONSTRAINT resource_reviewed_version_matches
  CHECK (reviewed_version_id IS NULL OR reviewed_state = 'reviewed');
CREATE FUNCTION resource_reviewed_insert_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.reviewed_state='reviewed' AND NEW.reviewed_version_id IS NULL
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_reviewed_insert_valid() FROM PUBLIC;
CREATE TRIGGER resource_reviewed_insert BEFORE INSERT ON resource
  FOR EACH ROW EXECUTE FUNCTION resource_reviewed_insert_valid();
ALTER TABLE resource ADD CONSTRAINT resource_reviewed_version_fk
  FOREIGN KEY (athlete_id, reviewed_version_id) REFERENCES resource_version (athlete_id, version_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION resource_head_transition_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.tags IS DISTINCT FROM OLD.tags
    OR NEW.favorite IS DISTINCT FROM OLD.favorite
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.access_revision<>OLD.access_revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS DISTINCT FROM NEW.updated_at
      OR NEW.current_version IS DISTINCT FROM OLD.current_version
      OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
      OR NEW.include_for_coach OR NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
      OR NEW.reviewed_version_id IS DISTINCT FROM OLD.reviewed_version_id
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  ELSIF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    -- Appending a version never promotes review or coach use, and never moves
    -- the reviewed version forward: the new body is unreviewed by definition.
    IF NEW.current_version<>OLD.current_version+1
      OR NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
      OR NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
      OR NEW.reviewed_version_id IS DISTINCT FROM OLD.reviewed_version_id
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
  ELSE
    IF NEW.current_version IS DISTINCT FROM OLD.current_version
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
    -- Review and coach use are separate explicit transitions. One statement may
    -- never enable coach use while also changing review, and review may not be
    -- withdrawn while coach use is still on: coach use is stopped first.
    IF NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
      AND NEW.include_for_coach IS DISTINCT FROM OLD.include_for_coach
      AND NEW.include_for_coach
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
    IF OLD.include_for_coach AND NEW.reviewed_state IS DISTINCT FROM OLD.reviewed_state
    THEN RAISE EXCEPTION 'REVIEW_WITHDRAWAL_BLOCKED'; END IF;
    -- The reviewed version only ever moves to the version being reviewed now.
    -- A resource whose body was replaced keeps pointing at the older version
    -- until the owner reviews the current one, and no other access command may
    -- move that pointer.
    IF NEW.reviewed_version_id IS DISTINCT FROM OLD.reviewed_version_id
      AND NEW.reviewed_version_id IS DISTINCT FROM NEW.current_version_id
      AND NEW.reviewed_version_id IS NOT NULL
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
    -- Becoming reviewed always pins, and a pin is never cleared while the
    -- resource stays reviewed. Rows migrated from before this column may keep
    -- their absent pin until the owner reviews the current body.
    IF NEW.reviewed_state='reviewed' AND NEW.reviewed_version_id IS NULL
      AND (OLD.reviewed_state<>'reviewed' OR OLD.reviewed_version_id IS NOT NULL)
    THEN RAISE EXCEPTION 'INVALID_RESOURCE_TRANSITION'; END IF;
    IF NEW.include_for_coach AND NOT EXISTS(
      SELECT 1 FROM public.consent c
      WHERE c.athlete_id=NEW.athlete_id AND c.kind='ai' AND c.granted
    ) THEN RAISE EXCEPTION 'COACH_USE_CONSENT_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- The query-time gate now also requires that the current version is the version
-- that was reviewed.
CREATE OR REPLACE FUNCTION public.resource_coach_use_authorized(uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.resource r
    WHERE r.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND r.id=$1
      AND r.deleted_at IS NULL AND r.include_for_coach AND r.reviewed_state='reviewed'
      AND r.reviewed_version_id=r.current_version_id
      AND EXISTS(SELECT 1 FROM public.consent c
        WHERE c.athlete_id=r.athlete_id AND c.kind='ai' AND c.granted)
      AND NOT EXISTS(SELECT 1 FROM public.resource_derived_cleanup q
        WHERE q.athlete_id=r.athlete_id AND q.resource_id=r.id AND q.completed_at IS NULL)
  );
$$;
REVOKE ALL ON FUNCTION public.resource_coach_use_authorized(uuid) FROM PUBLIC;

-- Completing a manifest widens the authorized set, so it takes the same tenant
-- command lock the access ledger and the retrieval capture use. Retrieval can
-- therefore not observe a set that changes underneath its own statements.
CREATE OR REPLACE FUNCTION public.finish_resource_derived_cleanup(uuid,uuid,boolean,text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
DECLARE tenant text;
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT athlete_id INTO tenant FROM public.resource_derived_cleanup WHERE id=$1;
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
  UPDATE public.resource_derived_cleanup SET
    completed_at=CASE WHEN $3 THEN database_now ELSE NULL END,
    available_at=CASE WHEN $3 THEN available_at
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    last_error_code=CASE WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'DERIVED_CLEANUP_FAILED'),88)
      ELSE left(coalesce($4,'DERIVED_CLEANUP_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_resource_derived_cleanup(uuid,uuid,boolean,text) FROM PUBLIC;

-- Expired cache rows are reclaimed by the same worker that drains the cleanup
-- queues; the TTL is not only a read filter.
CREATE FUNCTION public.prune_resource_retrieval_cache(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF $1<1 OR $1>1000 THEN RAISE EXCEPTION 'INVALID_PRUNE_LIMIT'; END IF;
  -- The privacy cleanup worker must never wait on another transaction: a row a
  -- long retrieval still holds is skipped, not queued behind.
  WITH candidates AS (
    SELECT athlete_id,cache_key FROM public.resource_retrieval_cache
    WHERE expires_at<=clock_timestamp()
    ORDER BY expires_at,athlete_id,cache_key LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.resource_retrieval_cache c USING candidates x
    WHERE c.athlete_id=x.athlete_id AND c.cache_key=x.cache_key;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.prune_resource_retrieval_cache(integer) FROM PUBLIC;

-- A citation may only name a passage its own grounding pinned. Service code
-- already checks this; the database now enforces the relationship too.
ALTER TABLE resource_citation ADD CONSTRAINT resource_citation_grounded_passage_fk
  FOREIGN KEY (athlete_id, grounding_id, passage_id)
  REFERENCES resource_grounding_excerpt (athlete_id, grounding_id, passage_id)
  ON DELETE CASCADE;
