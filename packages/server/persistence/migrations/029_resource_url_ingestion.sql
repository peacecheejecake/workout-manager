-- M2-04c records bounded URL fetch/parser work without creating a resource
-- version until both immutable artifacts have been published and parsed.
ALTER TABLE resource DROP CONSTRAINT IF EXISTS resource_source_kind_valid;
ALTER TABLE resource ADD CONSTRAINT resource_source_kind_valid
  CHECK (source_kind IN ('text','file','url'));

ALTER TABLE resource_version DROP CONSTRAINT IF EXISTS resource_version_source_xor;
ALTER TABLE resource_version DROP CONSTRAINT IF EXISTS resource_version_file_kind_matches;
ALTER TABLE resource_version ADD CONSTRAINT resource_version_source_shape CHECK (
  (content IS NOT NULL AND storage_ref IS NULL AND original_filename IS NULL
    AND media_type IS NULL AND size_bytes IS NULL
    AND octet_length(convert_to(content,'UTF8')) BETWEEN 1 AND 65536
    AND jsonb_array_length(paragraphs) BETWEEN 1 AND 1000 AND content_status='parsed')
  OR
  (content IS NULL AND storage_ref IS NOT NULL AND original_filename IS NOT NULL
    AND octet_length(convert_to(original_filename,'UTF8')) BETWEEN 1 AND 255
    AND original_filename=btrim(original_filename)
    AND media_type IN ('application/pdf','text/markdown') AND size_bytes BETWEEN 1 AND 10485760
    AND paragraphs='[]'::jsonb AND content_status='raw_stored')
  OR
  (content IS NULL AND storage_ref IS NULL AND original_filename IS NULL
    AND media_type IS NULL AND size_bytes IS NULL AND paragraphs='[]'::jsonb
    AND content_status='bookmark_only')
);

CREATE FUNCTION resource_version_source_kind_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent_kind text;
BEGIN
  SELECT source_kind INTO parent_kind FROM public.resource
    WHERE athlete_id=NEW.athlete_id AND id=NEW.resource_id;
  IF parent_kind='text' AND NOT (NEW.content IS NOT NULL AND NEW.content_status='parsed') THEN
    RAISE EXCEPTION 'INVALID_TEXT_RESOURCE_VERSION';
  ELSIF parent_kind='file' AND NOT (NEW.content IS NULL AND NEW.storage_ref IS NOT NULL
    AND NEW.content_status='raw_stored' AND ((NEW.media_type='application/pdf' AND NEW.size_bytes<=10485760)
      OR (NEW.media_type='text/markdown' AND NEW.size_bytes<=1048576))) THEN
    RAISE EXCEPTION 'INVALID_FILE_RESOURCE_VERSION';
  ELSIF parent_kind='url' AND NOT ((NEW.content IS NOT NULL AND NEW.content_status='parsed')
    OR (NEW.content IS NULL AND NEW.storage_ref IS NULL AND NEW.content_status='bookmark_only')) THEN
    RAISE EXCEPTION 'INVALID_URL_RESOURCE_VERSION';
  ELSIF parent_kind IS NULL THEN RAISE EXCEPTION 'RESOURCE_PARENT_NOT_FOUND'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_version_source_kind_valid() FROM PUBLIC;
CREATE TRIGGER resource_version_source_kind BEFORE INSERT ON resource_version
  FOR EACH ROW EXECUTE FUNCTION resource_version_source_kind_valid();

CREATE TABLE resource_url_ingestion (
  athlete_id text NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 200),
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('create','append')),
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  expected_current_version_id uuid,
  requested_url text NOT NULL CHECK (octet_length(requested_url) BETWEEN 1 AND 2048),
  display_url text NOT NULL CHECK (octet_length(display_url) BETWEEN 1 AND 2048),
  title text CHECK (title IS NULL OR (length(title) BETWEEN 1 AND 200 AND title=btrim(title))),
  category text CHECK (category IS NULL OR category IN ('paper','guide','note','race_material')),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=16384),
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags)='array' AND jsonb_array_length(tags)<=20 AND octet_length(tags::text)<=4096),
  favorite boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','fetching','parsing','finalized','bookmark_only','failed','cancelled')),
  failure_code text CHECK (failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 100 AND failure_code ~ '^[A-Z0-9_:-]+$')),
  failure_phase text CHECK (failure_phase IS NULL OR failure_phase IN ('fetch','parse')),
  failure_retryable boolean NOT NULL DEFAULT false,
  failed_at timestamptz,
  retry_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  lease_owner uuid,
  lease_token uuid,
  lease_until timestamptz,
  raw_temporary_ref text NOT NULL CHECK (length(raw_temporary_ref) BETWEEN 1 AND 512),
  raw_storage_ref text,
  raw_sha256 text CHECK (raw_sha256 IS NULL OR raw_sha256 ~ '^[a-f0-9]{64}$'),
  raw_size_bytes bigint CHECK (raw_size_bytes IS NULL OR raw_size_bytes BETWEEN 1 AND 10485760),
  raw_media_type text CHECK (raw_media_type IS NULL OR raw_media_type IN ('text/html','application/xhtml+xml','text/plain','text/markdown')),
  raw_published_at timestamptz,
  parsed_temporary_ref text NOT NULL CHECK (length(parsed_temporary_ref) BETWEEN 1 AND 512),
  parsed_storage_ref text,
  parsed_sha256 text CHECK (parsed_sha256 IS NULL OR parsed_sha256 ~ '^[a-f0-9]{64}$'),
  parsed_size_bytes bigint CHECK (parsed_size_bytes IS NULL OR parsed_size_bytes BETWEEN 1 AND 1048576),
  parsed_text text CHECK (parsed_text IS NULL OR octet_length(convert_to(parsed_text,'UTF8')) BETWEEN 1 AND 65536),
  fragments jsonb CHECK (fragments IS NULL OR (jsonb_typeof(fragments)='array' AND jsonb_array_length(fragments) BETWEEN 1 AND 1000 AND octet_length(fragments::text)<=524288)),
  parser_name text CHECK (parser_name IS NULL OR length(parser_name) BETWEEN 1 AND 100),
  parser_version text CHECK (parser_version IS NULL OR length(parser_version) BETWEEN 1 AND 100),
  parsed_published_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  PRIMARY KEY (athlete_id,request_id),
  UNIQUE (request_id),
  UNIQUE (athlete_id,idempotency_key),
  UNIQUE (athlete_id,resource_id,version_id),
  UNIQUE (raw_temporary_ref),
  UNIQUE (parsed_temporary_ref),
  CHECK ((operation='create' AND expected_current_version_id IS NULL AND title IS NOT NULL AND category IS NOT NULL)
    OR (operation='append' AND expected_current_version_id IS NOT NULL AND title IS NULL AND category IS NULL)),
  CHECK ((lease_owner IS NULL)=(lease_token IS NULL) AND (lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
  CHECK (updated_at>=created_at),
  CHECK ((raw_storage_ref IS NULL)=(raw_sha256 IS NULL) AND (raw_storage_ref IS NULL)=(raw_size_bytes IS NULL)
    AND (raw_storage_ref IS NULL)=(raw_media_type IS NULL)),
  CHECK ((parsed_storage_ref IS NULL)=(parsed_sha256 IS NULL) AND (parsed_storage_ref IS NULL)=(parsed_size_bytes IS NULL)),
  CHECK (parsed_text IS NULL OR (fragments IS NOT NULL AND parser_name IS NOT NULL AND parser_version IS NOT NULL)),
  CHECK ((state IN ('failed','cancelled'))=(failure_code IS NOT NULL)),
  CHECK ((state='failed')=(failure_phase IS NOT NULL)),
  CHECK ((state='failed')=(failed_at IS NOT NULL)),
  CHECK (retry_at IS NULL OR (state='failed' AND failure_retryable AND retry_at>=failed_at)),
  CHECK (state='failed' OR (NOT failure_retryable AND retry_at IS NULL)),
  CHECK ((state IN ('finalized','bookmark_only'))=(finalized_at IS NOT NULL))
);
CREATE INDEX resource_url_ingestion_claim ON resource_url_ingestion(updated_at,created_at,request_id)
  WHERE (state IN ('queued','fetching','parsing') OR (state='failed' AND failure_retryable))
    AND attempt_count<5;

CREATE TABLE resource_url_ingestion_attempt (
  athlete_id text NOT NULL,
  request_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  phase text NOT NULL CHECK (phase IN ('fetch','parse')),
  lease_token uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','lease_expired')),
  failure_code text CHECK (failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 100 AND failure_code ~ '^[A-Z0-9_:-]+$')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (athlete_id,request_id,attempt_no),
  UNIQUE (lease_token),
  FOREIGN KEY (athlete_id,request_id) REFERENCES resource_url_ingestion(athlete_id,request_id) ON DELETE CASCADE,
  CHECK ((status='running')=(completed_at IS NULL)),
  CHECK ((status IN ('failed','lease_expired'))=(failure_code IS NOT NULL))
);

CREATE TABLE resource_url_fetch_hop (
  athlete_id text NOT NULL,
  request_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  hop_index integer NOT NULL CHECK (hop_index BETWEEN 0 AND 5),
  display_url text NOT NULL CHECK (octet_length(display_url) BETWEEN 1 AND 2048),
  url_digest text NOT NULL CHECK (url_digest ~ '^[a-f0-9]{64}$'),
  response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  resolved_addresses inet[] NOT NULL CHECK (cardinality(resolved_addresses) BETWEEN 1 AND 8),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,request_id,attempt_no,hop_index),
  FOREIGN KEY (athlete_id,request_id,attempt_no)
    REFERENCES resource_url_ingestion_attempt(athlete_id,request_id,attempt_no) ON DELETE CASCADE
);

CREATE TABLE resource_url_artifact (
  athlete_id text NOT NULL,
  artifact_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('raw','parsed')),
  storage_ref text NOT NULL UNIQUE CHECK (length(storage_ref) BETWEEN 1 AND 512),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  media_type text NOT NULL CHECK (media_type IN ('text/html','application/xhtml+xml','text/plain','text/markdown','application/json')),
  derived_from_artifact_id uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,artifact_id),
  UNIQUE (athlete_id,version_id,kind),
  FOREIGN KEY (athlete_id,version_id) REFERENCES resource_version(athlete_id,version_id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id,request_id) REFERENCES resource_url_ingestion(athlete_id,request_id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id,derived_from_artifact_id) REFERENCES resource_url_artifact(athlete_id,artifact_id),
  CHECK ((kind='raw')=(derived_from_artifact_id IS NULL))
);

CREATE TABLE resource_url_provenance (
  athlete_id text NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid NOT NULL,
  request_id uuid NOT NULL,
  successful_attempt_no integer NOT NULL CHECK (successful_attempt_no BETWEEN 1 AND 5),
  requested_url text NOT NULL CHECK (octet_length(requested_url) BETWEEN 1 AND 2048),
  display_url text NOT NULL CHECK (octet_length(display_url) BETWEEN 1 AND 2048),
  final_display_url text NOT NULL CHECK (octet_length(final_display_url) BETWEEN 1 AND 2048),
  fetch_policy_version text NOT NULL CHECK (length(fetch_policy_version) BETWEEN 1 AND 100),
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id,version_id),
  FOREIGN KEY (athlete_id,version_id) REFERENCES resource_version(athlete_id,version_id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id,request_id,successful_attempt_no)
    REFERENCES resource_url_ingestion_attempt(athlete_id,request_id,attempt_no)
);

CREATE TABLE resource_url_locator (
  athlete_id text NOT NULL,
  version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  kind text NOT NULL CHECK (kind IN ('html_block','markdown_paragraph','plain_paragraph')),
  heading_path jsonb NOT NULL CHECK (jsonb_typeof(heading_path)='array' AND jsonb_array_length(heading_path)<=8 AND octet_length(heading_path::text)<=2048),
  paragraph_index integer CHECK (paragraph_index IS NULL OR paragraph_index BETWEEN 0 AND 999),
  page_number integer CHECK (page_number IS NULL OR page_number BETWEEN 1 AND 10000),
  start_offset integer NOT NULL CHECK (start_offset BETWEEN 0 AND 65535),
  end_offset integer NOT NULL CHECK (end_offset BETWEEN 1 AND 65536),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
  PRIMARY KEY (athlete_id,version_id,ordinal),
  FOREIGN KEY (athlete_id,version_id) REFERENCES resource_version(athlete_id,version_id) ON DELETE CASCADE,
  CHECK (end_offset>start_offset),
  CHECK ((kind='html_block' AND paragraph_index IS NULL)
    OR (kind IN ('markdown_paragraph','plain_paragraph') AND paragraph_index IS NOT NULL)),
  CHECK (kind<>'plain_paragraph' OR heading_path='[]'::jsonb)
);

ALTER TABLE resource_url_ingestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_url_ingestion FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_ingestion_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_url_ingestion_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_fetch_hop ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_url_fetch_hop FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_url_artifact FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_url_provenance FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_url_locator ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_url_locator FORCE ROW LEVEL SECURITY;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['resource_url_ingestion','resource_url_ingestion_attempt','resource_url_fetch_hop','resource_url_artifact','resource_url_provenance','resource_url_locator']
  LOOP EXECUTE format('CREATE POLICY %I_tenant ON %I USING (athlete_id=nullif(current_setting(''app.athlete_id'',true),'''')) WITH CHECK (athlete_id=nullif(current_setting(''app.athlete_id'',true),''''))',table_name,table_name); END LOOP;
END $$;

CREATE FUNCTION public.resource_url_request_by_key(text) RETURNS TABLE(request_digest text,requested_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT i.request_digest,i.requested_url FROM public.resource_url_ingestion i
  WHERE i.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND i.idempotency_key=$1
$$;
REVOKE ALL ON FUNCTION public.resource_url_request_by_key(text) FROM PUBLIC;

CREATE FUNCTION public.current_resource_url_request(uuid)
RETURNS TABLE(current_version_id uuid,requested_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.current_version_id,p.requested_url FROM public.resource r
  JOIN public.resource_url_provenance p
    ON p.athlete_id=r.athlete_id AND p.version_id=r.current_version_id
  WHERE r.athlete_id=nullif(current_setting('app.athlete_id',true),'') AND r.id=$1
    AND r.source_kind='url' AND r.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.current_resource_url_request(uuid) FROM PUBLIC;

CREATE FUNCTION resource_url_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND OLD.athlete_id IS NOT DISTINCT FROM nullif(current_setting('app.athlete_id',true),'')
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_RESOURCE_URL_RECORD';
END $$;
REVOKE ALL ON FUNCTION resource_url_immutable() FROM PUBLIC;
CREATE TRIGGER resource_url_hop_immutable BEFORE UPDATE OR DELETE ON resource_url_fetch_hop FOR EACH ROW EXECUTE FUNCTION resource_url_immutable();
CREATE TRIGGER resource_url_artifact_immutable BEFORE UPDATE OR DELETE ON resource_url_artifact FOR EACH ROW EXECUTE FUNCTION resource_url_immutable();
CREATE TRIGGER resource_url_provenance_immutable BEFORE UPDATE OR DELETE ON resource_url_provenance FOR EACH ROW EXECUTE FUNCTION resource_url_immutable();
CREATE TRIGGER resource_url_locator_immutable BEFORE UPDATE OR DELETE ON resource_url_locator FOR EACH ROW EXECUTE FUNCTION resource_url_immutable();

CREATE FUNCTION resource_url_attempt_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF OLD.status<>'running' OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
    OR NEW.phase IS DISTINCT FROM OLD.phase OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
    OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.status='running'
  THEN RAISE EXCEPTION 'IMMUTABLE_RESOURCE_URL_ATTEMPT'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resource_url_attempt_transition() FROM PUBLIC;
CREATE TRIGGER resource_url_attempt_transition BEFORE UPDATE ON resource_url_ingestion_attempt
  FOR EACH ROW EXECUTE FUNCTION resource_url_attempt_transition();

CREATE FUNCTION resource_url_utf16_length(text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE units integer:=0; DECLARE position integer;
BEGIN
  FOR position IN 1..length($1) LOOP
    units:=units+CASE WHEN ascii(substr($1,position,1))>65535 THEN 2 ELSE 1 END;
  END LOOP;
  RETURN units;
END $$;
REVOKE ALL ON FUNCTION resource_url_utf16_length(text) FROM PUBLIC;

CREATE FUNCTION resource_url_utf16_slice_matches(text,integer,integer,text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE units integer:=0; DECLARE start_position integer; DECLARE end_position integer;
DECLARE position integer; DECLARE character_units integer;
BEGIN
  IF $2<0 OR $3<=$2 THEN RETURN false; END IF;
  IF $2=0 THEN start_position:=1; END IF;
  FOR position IN 1..length($1) LOOP
    IF units=$2 THEN start_position:=position; END IF;
    character_units:=CASE WHEN ascii(substr($1,position,1))>65535 THEN 2 ELSE 1 END;
    units:=units+character_units;
    IF units=$3 THEN end_position:=position+1; EXIT; END IF;
    IF units>$2 AND start_position IS NULL OR units>$3 THEN RETURN false; END IF;
  END LOOP;
  IF units=$2 THEN start_position:=length($1)+1; END IF;
  IF units=$3 AND end_position IS NULL THEN end_position:=length($1)+1; END IF;
  RETURN start_position IS NOT NULL AND end_position IS NOT NULL
    AND substr($1,start_position,end_position-start_position)=$4;
END $$;
REVOKE ALL ON FUNCTION resource_url_utf16_slice_matches(text,integer,integer,text) FROM PUBLIC;

CREATE FUNCTION close_resource_url_attempts(text,uuid,text,timestamptz) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  UPDATE public.resource_url_ingestion_attempt SET status='failed',failure_code=$3,completed_at=$4
    WHERE athlete_id=$1 AND request_id=$2 AND status='running';
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION close_resource_url_attempts(text,uuid,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION queue_resource_url_refs(text,uuid,text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$3,clock_timestamp(),clock_timestamp()
    FROM public.resource_url_ingestion i
    CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.raw_storage_ref),(i.parsed_temporary_ref),(i.parsed_storage_ref)) refs(storage_ref)
    WHERE i.athlete_id=$1 AND i.request_id=$2 AND refs.storage_ref IS NOT NULL
    ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,
      completed_at=NULL,delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION queue_resource_url_refs(text,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.enqueue_abandoned_resource_url_object(text,uuid,uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prefix text; DECLARE suffix text; DECLARE request_exists boolean; DECLARE ref_matches boolean;
BEGIN
  prefix:='private/v1/tenants/'||$1||'/resources/'||$3::text||'/url-ingestions/'||$2::text||'/';
  IF left($4,length(prefix))<>prefix THEN RETURN false; END IF;
  suffix:=substr($4,length(prefix)+1);
  IF suffix !~ '^(raw/sha256/[a-f0-9]{64}\.(html|xhtml|txt|md)|parsed/sha256/[a-f0-9]{64}\.json)$'
  THEN RETURN false; END IF;
  SELECT count(*)>0,bool_or(i.athlete_id=$1 AND i.resource_id=$3
    AND $4 IN (i.raw_storage_ref,i.parsed_storage_ref)) INTO request_exists,ref_matches
    FROM public.resource_url_ingestion i WHERE i.request_id=$2;
  IF request_exists AND NOT coalesce(ref_matches,false) THEN RETURN false; END IF;
  IF NOT request_exists AND NOT EXISTS(
    SELECT 1 FROM public.resource_object_cleanup q WHERE q.storage_ref=$4
  ) THEN RETURN false; END IF;
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    VALUES(gen_random_uuid(),$4,'upload_abandoned',clock_timestamp(),clock_timestamp())
    ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,
      completed_at=NULL,delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_abandoned_resource_url_object(text,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION protect_resource_url_ref(text) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.resource_object_cleanup WHERE storage_ref=$1 AND completed_at IS NULL AND delete_authorized_at IS NOT NULL)
  THEN RAISE EXCEPTION 'OBJECT_DELETE_IN_PROGRESS'; END IF;
  UPDATE public.resource_object_cleanup SET completed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
    delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT'
    WHERE storage_ref=$1 AND completed_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION protect_resource_url_ref(text) FROM PUBLIC;

CREATE FUNCTION public.lease_resource_url_ingestion(uuid,interval)
RETURNS TABLE(athlete_id text,request_id uuid,attempt_no integer,phase text,lease_token uuid,requested_url text,
  display_url text,resource_id uuid,version_id uuid,raw_temporary_ref text,raw_storage_ref text,
  raw_media_type text,parsed_temporary_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  IF $2<=interval '0 seconds' OR $2>interval '5 minutes' THEN RAISE EXCEPTION 'INVALID_URL_LEASE'; END IF;
  RETURN QUERY WITH candidate AS (
    SELECT i.athlete_id,i.request_id,
      CASE WHEN i.raw_published_at IS NULL THEN 'fetch' ELSE 'parse' END AS phase
    FROM public.resource_url_ingestion i
    WHERE (i.state IN ('queued','fetching','parsing')
        OR (i.state='failed' AND i.failure_retryable AND i.retry_at<=database_now))
      AND i.expires_at>database_now AND i.attempt_count<5
      AND (i.lease_until IS NULL OR i.lease_until<=database_now)
    ORDER BY (i.raw_published_at IS NULL),i.updated_at,i.created_at,i.request_id
      FOR UPDATE SKIP LOCKED LIMIT 1
  ), expired_attempt AS (
    UPDATE public.resource_url_ingestion_attempt a SET status='lease_expired',failure_code='LEASE_EXPIRED',completed_at=database_now
    FROM candidate c WHERE a.athlete_id=c.athlete_id AND a.request_id=c.request_id
      AND a.status='running' RETURNING a.request_id
  ), changed AS (
    UPDATE public.resource_url_ingestion i SET state=CASE WHEN c.phase='fetch' THEN 'fetching' ELSE 'parsing' END,
      failure_code=NULL,failure_phase=NULL,failure_retryable=false,failed_at=NULL,retry_at=NULL,
      attempt_count=i.attempt_count+1,lease_owner=$1,lease_token=gen_random_uuid(),lease_until=database_now+$2,updated_at=database_now
    FROM candidate c WHERE i.athlete_id=c.athlete_id AND i.request_id=c.request_id
    RETURNING i.*,c.phase
  ), attempt AS (
    INSERT INTO public.resource_url_ingestion_attempt(athlete_id,request_id,attempt_no,phase,lease_token,status,started_at)
      SELECT c.athlete_id,c.request_id,c.attempt_count,c.phase,c.lease_token,'running',database_now FROM changed c
  )
  SELECT c.athlete_id,c.request_id,c.attempt_count,c.phase,c.lease_token,c.requested_url,c.display_url,
    c.resource_id,c.version_id,c.raw_temporary_ref,c.raw_storage_ref,c.raw_media_type,c.parsed_temporary_ref FROM changed c;
END $$;
REVOKE ALL ON FUNCTION public.lease_resource_url_ingestion(uuid,interval) FROM PUBLIC;

CREATE FUNCTION public.record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text; DECLARE request uuid; DECLARE attempt integer;
BEGIN
  SELECT i.athlete_id,i.request_id,i.attempt_count INTO tenant,request,attempt
    FROM public.resource_url_ingestion i WHERE i.request_id=$1 AND i.lease_token=$2
      AND i.lease_until>clock_timestamp() AND i.state='fetching';
  IF tenant IS NULL OR $3<0 OR $3>5 THEN RETURN false; END IF;
  INSERT INTO public.resource_url_fetch_hop(athlete_id,request_id,attempt_no,hop_index,display_url,url_digest,
    response_status,resolved_addresses,policy_version,observed_at)
    VALUES(tenant,request,attempt,$3,$4,$5,$6,$7,$8,clock_timestamp());
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text) FROM PUBLIC;

CREATE FUNCTION public.prepare_resource_url_raw(uuid,uuid,text,text,bigint,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public.resource_url_ingestion%ROWTYPE; DECLARE hash text;
BEGIN
  SELECT * INTO i FROM public.resource_url_ingestion
    WHERE request_id=$1 AND lease_token=$2 AND state='fetching' AND lease_until>clock_timestamp() FOR UPDATE;
  IF i.request_id IS NULL THEN RETURN false; END IF;
  hash:=lower($4);
  IF $3 !~ ('^private/v1/tenants/'||i.athlete_id||'/resources/'||i.resource_id::text||'/url-ingestions/'||$1::text||'/raw/sha256/'||hash||'\.(html|xhtml|txt|md)$')
    OR ($6='text/html' AND $3 !~ '\.html$')
    OR ($6='application/xhtml+xml' AND $3 !~ '\.xhtml$')
    OR ($6='text/plain' AND $3 !~ '\.txt$')
    OR ($6='text/markdown' AND $3 !~ '\.md$')
  THEN RAISE EXCEPTION 'INVALID_URL_OBJECT_REF'; END IF;
  IF i.raw_storage_ref IS NOT NULL THEN
    IF i.raw_storage_ref=$3 AND i.raw_sha256=hash AND i.raw_size_bytes=$5 AND i.raw_media_type=$6
    THEN RETURN true; END IF;
    RAISE EXCEPTION 'URL_ARTIFACT_CONFLICT';
  END IF;
  PERFORM public.protect_resource_url_ref($3);
  UPDATE public.resource_url_ingestion SET raw_storage_ref=$3,raw_sha256=hash,raw_size_bytes=$5,
    raw_media_type=$6,updated_at=clock_timestamp() WHERE athlete_id=i.athlete_id AND request_id=$1;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.prepare_resource_url_raw(uuid,uuid,text,text,bigint,text) FROM PUBLIC;

CREATE FUNCTION public.mark_resource_url_raw_published(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer; DECLARE tenant text; DECLARE attempt integer;
BEGIN
  UPDATE public.resource_url_ingestion SET raw_published_at=clock_timestamp(),state='parsing',
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
  WHERE request_id=$1 AND lease_token=$2 AND state='fetching' AND lease_until>clock_timestamp()
    AND raw_storage_ref IS NOT NULL RETURNING athlete_id,attempt_count INTO tenant,attempt;
  GET DIAGNOSTICS affected=ROW_COUNT; IF affected=0 THEN RETURN false; END IF;
  UPDATE public.resource_url_ingestion_attempt SET status='succeeded',completed_at=clock_timestamp()
    WHERE athlete_id=tenant AND request_id=$1 AND attempt_no=attempt AND status='running';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mark_resource_url_raw_published(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public.resource_url_ingestion%ROWTYPE; DECLARE hash text;
BEGIN
  SELECT * INTO i FROM public.resource_url_ingestion
    WHERE request_id=$1 AND lease_token=$2 AND state='parsing' AND lease_until>clock_timestamp() FOR UPDATE;
  IF i.request_id IS NULL THEN RETURN false; END IF;
  hash:=lower($4);
  IF $3 !~ ('^private/v1/tenants/'||i.athlete_id||'/resources/'||i.resource_id::text||'/url-ingestions/'||$1::text||'/parsed/sha256/'||hash||'\.json$')
  THEN RAISE EXCEPTION 'INVALID_URL_OBJECT_REF'; END IF;
  IF i.parsed_storage_ref IS NOT NULL THEN
    IF i.parsed_storage_ref=$3 AND i.parsed_sha256=hash AND i.parsed_size_bytes=$5
      AND i.parsed_text=$6 AND i.fragments=$7 AND i.parser_name=$8 AND i.parser_version=$9
    THEN RETURN true; END IF;
    RAISE EXCEPTION 'URL_ARTIFACT_CONFLICT';
  END IF;
  PERFORM public.protect_resource_url_ref($3);
  UPDATE public.resource_url_ingestion SET parsed_storage_ref=$3,parsed_sha256=hash,parsed_size_bytes=$5,
    parsed_text=$6,fragments=$7,parser_name=$8,parser_version=$9,updated_at=clock_timestamp()
    WHERE athlete_id=i.athlete_id AND request_id=$1;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION public.mark_resource_url_parsed_published(uuid,uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  UPDATE public.resource_url_ingestion SET parsed_published_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE request_id=$1 AND lease_token=$2 AND state='parsing' AND lease_until>clock_timestamp()
    AND parsed_storage_ref IS NOT NULL AND parsed_text IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.mark_resource_url_parsed_published(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.assert_resource_url_quota(text,boolean,bigint,bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE quota record;
BEGIN
  SELECT
    count(DISTINCT r.id) FILTER (WHERE r.deleted_at IS NULL)::integer AS active_resources,
    count(v.version_id) FILTER (WHERE r.deleted_at IS NULL)::integer AS active_versions,
    coalesce(sum(octet_length(convert_to(v.content,'UTF8'))+octet_length(v.paragraphs::text))
      FILTER (WHERE r.deleted_at IS NULL AND v.content IS NOT NULL),0)::bigint AS active_text_bytes,
    coalesce(sum(v.size_bytes) FILTER (WHERE r.deleted_at IS NULL AND v.storage_ref IS NOT NULL),0)::bigint
      +coalesce((SELECT sum(a.size_bytes) FROM public.resource_url_artifact a
        JOIN public.resource ar ON ar.athlete_id=a.athlete_id AND ar.id=a.resource_id
        WHERE a.athlete_id=$1 AND ar.deleted_at IS NULL),0)::bigint AS active_object_bytes,
    count(v.version_id)::integer AS total_versions,
    coalesce(sum(octet_length(convert_to(v.content,'UTF8'))+octet_length(v.paragraphs::text))
      FILTER (WHERE v.content IS NOT NULL),0)::bigint AS total_text_bytes,
    coalesce(sum(v.size_bytes) FILTER (WHERE v.storage_ref IS NOT NULL),0)::bigint
      +coalesce((SELECT sum(a.size_bytes) FROM public.resource_url_artifact a
        WHERE a.athlete_id=$1),0)::bigint AS total_object_bytes
  INTO quota FROM public.resource r LEFT JOIN public.resource_version v
    ON v.athlete_id=r.athlete_id AND v.resource_id=r.id WHERE r.athlete_id=$1;
  IF quota.active_resources+(CASE WHEN $2 THEN 1 ELSE 0 END)>100
    OR quota.active_versions+1>1000 OR quota.active_text_bytes+$3>4194304
    OR quota.active_object_bytes+$4>104857600 OR quota.total_versions+1>2000
    OR quota.total_text_bytes+$3>16777216 OR quota.total_object_bytes+$4>524288000
  THEN RAISE EXCEPTION 'RESOURCE_QUOTA_EXCEEDED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_resource_url_quota(text,boolean,bigint,bigint) FROM PUBLIC;

CREATE FUNCTION public.finalize_resource_url_ingestion(uuid,uuid) RETURNS TABLE(resource_id uuid,version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public.resource_url_ingestion%ROWTYPE; DECLARE at timestamptz:=statement_timestamp();
DECLARE next_version integer; DECLARE previous_version integer; DECLARE raw_id uuid:=gen_random_uuid();
DECLARE parsed_id uuid:=gen_random_uuid(); DECLARE final_hop record; DECLARE current_head uuid;
DECLARE tenant text;
BEGIN
  SELECT candidate.athlete_id INTO tenant FROM public.resource_url_ingestion candidate
    WHERE candidate.request_id=$1;
  IF tenant IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
  SELECT * INTO i FROM public.resource_url_ingestion WHERE request_id=$1 AND lease_token=$2
    AND state='parsing' AND lease_until>clock_timestamp() FOR UPDATE;
  IF i.request_id IS NULL THEN RETURN; END IF;
  IF i.raw_published_at IS NULL OR i.parsed_published_at IS NULL OR i.parsed_text IS NULL OR i.fragments IS NULL
  THEN RAISE EXCEPTION 'URL_ARTIFACT_NOT_PUBLISHED'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(i.fragments) WITH ORDINALITY AS e(value,position)
    WHERE jsonb_typeof(e.value->'headingPath') IS DISTINCT FROM 'array')
  THEN RAISE EXCEPTION 'INVALID_URL_LOCATOR'; END IF;
  PERFORM public.assert_resource_url_quota(i.athlete_id,i.operation='create',
    octet_length(convert_to(i.parsed_text,'UTF8'))+octet_length(i.fragments::text),
    i.raw_size_bytes+i.parsed_size_bytes);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(i.fragments) WITH ORDINALITY AS e(value,position)
    CROSS JOIN LATERAL jsonb_to_record(e.value) AS f("ordinal" integer,"kind" text,"headingPath" jsonb,
      "paragraphIndex" integer,"text" text,"startOffset" integer,"endOffset" integer,"pageNumber" integer)
    WHERE f."ordinal" IS DISTINCT FROM e.position-1
      OR f."kind" IS NULL OR f."kind" NOT IN ('html_block','markdown_paragraph','plain_paragraph')
      OR jsonb_array_length(f."headingPath")>8
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(f."headingPath") h(value)
        WHERE jsonb_typeof(h.value)<>'string' OR octet_length(h.value#>>'{}') NOT BETWEEN 1 AND 200)
      OR (f."kind"='html_block' AND f."paragraphIndex" IS NOT NULL)
      OR (f."kind" IN ('markdown_paragraph','plain_paragraph') AND f."paragraphIndex" IS NULL)
      OR (f."kind"='plain_paragraph' AND f."headingPath"<>'[]'::jsonb)
      OR f."text" IS NULL OR f."startOffset"<0 OR f."endOffset"<=f."startOffset"
      OR f."endOffset">public.resource_url_utf16_length(i.parsed_text)
      OR NOT public.resource_url_utf16_slice_matches(
        i.parsed_text,f."startOffset",f."endOffset",f."text"))
  THEN RAISE EXCEPTION 'INVALID_URL_LOCATOR'; END IF;
  IF i.operation='create' THEN
    next_version:=1; previous_version:=NULL;
    INSERT INTO public.resource(athlete_id,id,source_kind,title,category,metadata,tags,favorite,
      include_for_coach,reviewed_state,access_revision,current_version,current_version_id,created_at,updated_at)
      VALUES(i.athlete_id,i.resource_id,'url',i.title,i.category,i.metadata,i.tags,i.favorite,
        false,'unreviewed',1,1,i.version_id,at,at);
  ELSE
    SELECT r.current_version,r.current_version_id INTO previous_version,current_head
      FROM public.resource r WHERE r.athlete_id=i.athlete_id AND r.id=i.resource_id
        AND r.source_kind='url' AND r.deleted_at IS NULL FOR UPDATE;
    IF previous_version IS NULL OR current_head IS DISTINCT FROM i.expected_current_version_id
    THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
    next_version:=previous_version+1;
  END IF;
  INSERT INTO public.resource_version(athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
    content,content_hash,paragraphs,content_status,index_status,created_at)
    VALUES(i.athlete_id,i.resource_id,i.version_id,next_version,previous_version,
      CASE WHEN previous_version IS NULL THEN NULL ELSE i.expected_current_version_id END,
      i.parsed_text,i.raw_sha256,i.fragments,'parsed','not_indexed',at);
  INSERT INTO public.resource_url_artifact(athlete_id,artifact_id,resource_id,version_id,request_id,kind,
    storage_ref,content_hash,size_bytes,media_type,derived_from_artifact_id,created_at)
    VALUES(i.athlete_id,raw_id,i.resource_id,i.version_id,i.request_id,'raw',i.raw_storage_ref,
      i.raw_sha256,i.raw_size_bytes,i.raw_media_type,NULL,at),
      (i.athlete_id,parsed_id,i.resource_id,i.version_id,i.request_id,'parsed',i.parsed_storage_ref,
      i.parsed_sha256,i.parsed_size_bytes,'application/json',raw_id,at);
  SELECT h.display_url,h.policy_version,h.attempt_no,h.observed_at,h.hop_index,h.response_status
    INTO final_hop
    FROM public.resource_url_fetch_hop h WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
    ORDER BY h.attempt_no DESC,h.hop_index DESC LIMIT 1;
  IF final_hop IS NULL OR final_hop.response_status<>200
    OR (SELECT count(*) FROM public.resource_url_fetch_hop h
        WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
          AND h.attempt_no=final_hop.attempt_no)<>final_hop.hop_index+1
    OR EXISTS(SELECT 1 FROM public.resource_url_fetch_hop h
        WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
          AND h.attempt_no=final_hop.attempt_no AND h.hop_index<final_hop.hop_index
          AND h.response_status NOT IN (301,302,303,307,308))
  THEN RAISE EXCEPTION 'MISSING_URL_PROVENANCE'; END IF;
  INSERT INTO public.resource_url_provenance(athlete_id,resource_id,version_id,request_id,successful_attempt_no,
    requested_url,display_url,final_display_url,fetch_policy_version,fetched_at)
    VALUES(i.athlete_id,i.resource_id,i.version_id,i.request_id,final_hop.attempt_no,
      i.requested_url,i.display_url,final_hop.display_url,final_hop.policy_version,final_hop.observed_at);
  INSERT INTO public.resource_url_locator(athlete_id,version_id,ordinal,kind,heading_path,paragraph_index,
    page_number,start_offset,end_offset,text)
    SELECT i.athlete_id,i.version_id,(e.value->>'ordinal')::integer,e.value->>'kind',e.value->'headingPath',
      CASE WHEN e.value?'paragraphIndex' THEN (e.value->>'paragraphIndex')::integer ELSE NULL END,
      CASE WHEN e.value?'pageNumber' THEN (e.value->>'pageNumber')::integer ELSE NULL END,
      (e.value->>'startOffset')::integer,(e.value->>'endOffset')::integer,e.value->>'text'
    FROM jsonb_array_elements(i.fragments) WITH ORDINALITY AS e(value,ordinality);
  IF i.operation='append' THEN
    UPDATE public.resource SET current_version=next_version,current_version_id=i.version_id,
      access_revision=access_revision+1,updated_at=at WHERE athlete_id=i.athlete_id AND id=i.resource_id;
  END IF;
  UPDATE public.resource_url_ingestion SET state='finalized',finalized_at=at,updated_at=at,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE athlete_id=i.athlete_id AND request_id=i.request_id;
  UPDATE public.resource_url_ingestion_attempt SET status='succeeded',completed_at=at
    WHERE athlete_id=i.athlete_id AND request_id=i.request_id AND attempt_no=i.attempt_count AND status='running';
  INSERT INTO public.command_receipt(athlete_id,idempotency_key,request,result)
    VALUES(i.athlete_id,'resource:url:'||i.idempotency_key,jsonb_build_object('sha256',i.request_digest),
      jsonb_build_object('status','available','resourceId',i.resource_id,'versionId',i.version_id));
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES(i.athlete_id,gen_random_uuid(),'resource:url:'||i.idempotency_key,'resource.url_ingested',
      jsonb_build_object('resourceId',i.resource_id,'versionId',i.version_id));
  RETURN QUERY SELECT i.resource_id,i.version_id;
END $$;
REVOKE ALL ON FUNCTION public.finalize_resource_url_ingestion(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.cancel_resource_url_ingestion(uuid,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); DECLARE affected integer;
DECLARE cancelled_at timestamptz:=clock_timestamp();
BEGIN
  UPDATE public.resource_url_ingestion SET state='cancelled',failure_code=$2,lease_owner=NULL,lease_token=NULL,
    lease_until=NULL,failure_phase=NULL,failure_retryable=false,failed_at=NULL,retry_at=NULL,
    updated_at=cancelled_at WHERE athlete_id=tenant AND request_id=$1
    AND (state IN ('queued','fetching','parsing') OR (state='failed' AND failure_retryable));
  GET DIAGNOSTICS affected=ROW_COUNT; IF affected=0 THEN RETURN false; END IF;
  PERFORM public.close_resource_url_attempts(tenant,$1,$2,cancelled_at);
  PERFORM public.queue_resource_url_refs(tenant,$1,'upload_abandoned'); RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.cancel_resource_url_ingestion(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.mark_resource_url_bookmark_only(uuid,uuid,text,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public.resource_url_ingestion%ROWTYPE; DECLARE at timestamptz:=statement_timestamp();
DECLARE next_version integer; DECLARE previous_version integer; DECLARE current_head uuid;
DECLARE raw_id uuid:=gen_random_uuid(); DECLARE final_hop record; DECLARE tenant text;
BEGIN
  SELECT candidate.athlete_id INTO tenant FROM public.resource_url_ingestion candidate
    WHERE candidate.request_id=$1;
  IF tenant IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
  SELECT * INTO i FROM public.resource_url_ingestion WHERE request_id=$1 AND lease_token=$2
    AND state='parsing' AND lease_until>clock_timestamp() FOR UPDATE;
  IF i.request_id IS NULL THEN RETURN false; END IF;
  IF i.raw_published_at IS NULL OR i.raw_storage_ref IS NULL OR i.raw_sha256 IS NULL
  THEN RAISE EXCEPTION 'URL_RAW_NOT_PUBLISHED'; END IF;
  PERFORM public.assert_resource_url_quota(i.athlete_id,i.operation='create',0,i.raw_size_bytes);
  IF $3 IS NULL OR btrim($3)='' OR length($3)>100 OR $4 IS NULL OR btrim($4)='' OR length($4)>100
  THEN RAISE EXCEPTION 'INVALID_URL_PARSER_PROVENANCE'; END IF;
  IF i.operation='create' THEN
    next_version:=1; previous_version:=NULL;
    INSERT INTO public.resource(athlete_id,id,source_kind,title,category,metadata,tags,favorite,
      include_for_coach,reviewed_state,access_revision,current_version,current_version_id,created_at,updated_at)
      VALUES(i.athlete_id,i.resource_id,'url',i.title,i.category,i.metadata,i.tags,i.favorite,
        false,'unreviewed',1,1,i.version_id,at,at);
  ELSE
    SELECT r.current_version,r.current_version_id INTO previous_version,current_head
      FROM public.resource r WHERE r.athlete_id=i.athlete_id AND r.id=i.resource_id
        AND r.source_kind='url' AND r.deleted_at IS NULL FOR UPDATE;
    IF previous_version IS NULL OR current_head IS DISTINCT FROM i.expected_current_version_id
    THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
    next_version:=previous_version+1;
  END IF;
  INSERT INTO public.resource_version(athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
    content,content_hash,paragraphs,content_status,index_status,created_at)
    VALUES(i.athlete_id,i.resource_id,i.version_id,next_version,previous_version,
      CASE WHEN previous_version IS NULL THEN NULL ELSE i.expected_current_version_id END,
      NULL,i.raw_sha256,'[]'::jsonb,'bookmark_only','not_indexed',at);
  INSERT INTO public.resource_url_artifact(athlete_id,artifact_id,resource_id,version_id,request_id,kind,
    storage_ref,content_hash,size_bytes,media_type,derived_from_artifact_id,created_at)
    VALUES(i.athlete_id,raw_id,i.resource_id,i.version_id,i.request_id,'raw',i.raw_storage_ref,
      i.raw_sha256,i.raw_size_bytes,i.raw_media_type,NULL,at);
  SELECT h.display_url,h.policy_version,h.attempt_no,h.observed_at,h.hop_index,h.response_status
    INTO final_hop
    FROM public.resource_url_fetch_hop h WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
    ORDER BY h.attempt_no DESC,h.hop_index DESC LIMIT 1;
  IF final_hop IS NULL OR final_hop.response_status<>200
    OR (SELECT count(*) FROM public.resource_url_fetch_hop h
        WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
          AND h.attempt_no=final_hop.attempt_no)<>final_hop.hop_index+1
    OR EXISTS(SELECT 1 FROM public.resource_url_fetch_hop h
        WHERE h.athlete_id=i.athlete_id AND h.request_id=i.request_id
          AND h.attempt_no=final_hop.attempt_no AND h.hop_index<final_hop.hop_index
          AND h.response_status NOT IN (301,302,303,307,308))
  THEN RAISE EXCEPTION 'MISSING_URL_PROVENANCE'; END IF;
  INSERT INTO public.resource_url_provenance(athlete_id,resource_id,version_id,request_id,successful_attempt_no,
    requested_url,display_url,final_display_url,fetch_policy_version,fetched_at)
    VALUES(i.athlete_id,i.resource_id,i.version_id,i.request_id,final_hop.attempt_no,
      i.requested_url,i.display_url,final_hop.display_url,final_hop.policy_version,final_hop.observed_at);
  IF i.operation='append' THEN
    UPDATE public.resource SET current_version=next_version,current_version_id=i.version_id,
      access_revision=access_revision+1,updated_at=at WHERE athlete_id=i.athlete_id AND id=i.resource_id;
  END IF;
  UPDATE public.resource_url_ingestion SET state='bookmark_only',parser_name=btrim($3),parser_version=btrim($4),
    finalized_at=at,updated_at=at,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE athlete_id=i.athlete_id AND request_id=i.request_id;
  UPDATE public.resource_url_ingestion_attempt SET status='succeeded',completed_at=at
    WHERE athlete_id=i.athlete_id AND request_id=i.request_id AND attempt_no=i.attempt_count AND status='running';
  INSERT INTO public.command_receipt(athlete_id,idempotency_key,request,result)
    VALUES(i.athlete_id,'resource:url:'||i.idempotency_key,jsonb_build_object('sha256',i.request_digest),
      jsonb_build_object('status','available','resourceId',i.resource_id,'versionId',i.version_id));
  INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload)
    VALUES(i.athlete_id,gen_random_uuid(),'resource:url:'||i.idempotency_key,'resource.url_bookmarked',
      jsonb_build_object('resourceId',i.resource_id,'versionId',i.version_id));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mark_resource_url_bookmark_only(uuid,uuid,text,text) FROM PUBLIC;

CREATE FUNCTION public.fail_resource_url_ingestion(uuid,uuid,text,boolean,interval) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text; DECLARE affected integer; DECLARE attempt integer;
BEGIN
  IF $5<interval '0 seconds' OR $5>interval '24 hours' OR (NOT $4 AND $5<>interval '0 seconds')
  THEN RAISE EXCEPTION 'INVALID_URL_RETRY'; END IF;
  UPDATE public.resource_url_ingestion SET state='failed',failure_code=$3,
    failure_phase=CASE WHEN state='fetching' THEN 'fetch' ELSE 'parse' END,
    failure_retryable=($4 AND attempt_count<5),
    failed_at=clock_timestamp(),retry_at=CASE WHEN $4 AND attempt_count<5 THEN clock_timestamp()+$5 ELSE NULL END,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE request_id=$1 AND lease_token=$2
    AND state IN ('fetching','parsing') AND lease_until>clock_timestamp()
    RETURNING athlete_id,attempt_count INTO tenant,attempt;
  GET DIAGNOSTICS affected=ROW_COUNT; IF affected=0 THEN RETURN false; END IF;
  UPDATE public.resource_url_ingestion_attempt SET status='failed',failure_code=$3,completed_at=clock_timestamp()
    WHERE athlete_id=tenant AND request_id=$1 AND attempt_no=attempt AND status='running';
  IF NOT ($4 AND attempt<5) THEN
    PERFORM public.queue_resource_url_refs(tenant,$1,'upload_abandoned');
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fail_resource_url_ingestion(uuid,uuid,text,boolean,interval) FROM PUBLIC;

CREATE FUNCTION public.reap_resource_url_ingestions(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record; DECLARE affected integer:=0; DECLARE database_now timestamptz:=statement_timestamp();
BEGIN
  IF $1<1 OR $1>100 THEN RAISE EXCEPTION 'INVALID_REAP_LIMIT'; END IF;
  FOR item IN WITH candidates AS (
    SELECT athlete_id,request_id FROM public.resource_url_ingestion
    WHERE (state IN ('queued','fetching','parsing') OR (state='failed' AND failure_retryable))
      AND expires_at<=database_now
    ORDER BY expires_at,request_id FOR UPDATE SKIP LOCKED LIMIT $1
  ) UPDATE public.resource_url_ingestion i SET state='failed',failure_code='INGESTION_EXPIRED',
      failure_phase=CASE WHEN i.raw_published_at IS NULL THEN 'fetch' ELSE 'parse' END,
      failure_retryable=false,failed_at=database_now,retry_at=NULL,
      lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=database_now
    FROM candidates c WHERE i.athlete_id=c.athlete_id AND i.request_id=c.request_id
    RETURNING i.athlete_id,i.request_id
  LOOP
    PERFORM public.close_resource_url_attempts(item.athlete_id,item.request_id,'INGESTION_EXPIRED',database_now);
    PERFORM public.queue_resource_url_refs(item.athlete_id,item.request_id,'upload_abandoned');
    affected:=affected+1;
  END LOOP;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.reap_resource_url_ingestions(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enqueue_resource_object_cleanup(uuid,text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),''); DECLARE affected integer;
BEGIN
  IF tenant IS NULL OR $2<>'resource_deleted' OR NOT EXISTS(
    SELECT 1 FROM public.resource WHERE athlete_id=tenant AND id=$1 AND deleted_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'INVALID_RESOURCE_CLEANUP'; END IF;
  UPDATE public.resource_url_ingestion SET state='cancelled',failure_code='RESOURCE_DELETED',
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,failure_phase=NULL,failure_retryable=false,
    failed_at=NULL,retry_at=NULL,updated_at=clock_timestamp()
    WHERE athlete_id=tenant AND resource_id=$1
      AND (state IN ('queued','fetching','parsing') OR (state='failed' AND failure_retryable));
  UPDATE public.resource_url_ingestion_attempt a SET status='failed',failure_code='RESOURCE_DELETED',
    completed_at=clock_timestamp() FROM public.resource_url_ingestion i
    WHERE i.athlete_id=tenant AND i.resource_id=$1 AND a.athlete_id=i.athlete_id
      AND a.request_id=i.request_id AND a.status='running';
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,$2,clock_timestamp(),clock_timestamp() FROM (
      SELECT v.storage_ref FROM public.resource_version v WHERE v.athlete_id=tenant AND v.resource_id=$1 AND v.storage_ref IS NOT NULL
      UNION SELECT a.storage_ref FROM public.resource_url_artifact a WHERE a.athlete_id=tenant AND a.resource_id=$1
      UNION SELECT x.storage_ref FROM public.resource_url_ingestion i
        CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.raw_storage_ref),(i.parsed_temporary_ref),(i.parsed_storage_ref)) x(storage_ref)
        WHERE i.athlete_id=tenant AND i.resource_id=$1 AND x.storage_ref IS NOT NULL
    ) refs ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,
      completed_at=NULL,delete_authorized_at=NULL,last_error_code=NULL
    WHERE public.resource_object_cleanup.completed_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_resource_object_cleanup(uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz)
RETURNS TABLE(id uuid,storage_ref text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE object_ref text; DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  SELECT q.storage_ref INTO object_ref FROM public.resource_object_cleanup q
    WHERE q.id=$1 AND q.lease_owner=$2 AND q.completed_at IS NULL AND q.lease_until>database_now FOR UPDATE;
  IF object_ref IS NULL THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.resource_version v JOIN public.resource r ON r.athlete_id=v.athlete_id AND r.id=v.resource_id
      WHERE v.storage_ref=object_ref AND r.deleted_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.resource_upload_intent i WHERE (i.storage_ref=object_ref OR i.temporary_ref=object_ref)
      AND i.state IN ('reserved','prepared','staged') AND i.expires_at>database_now)
    OR EXISTS(SELECT 1 FROM public.resource_url_artifact a JOIN public.resource r ON r.athlete_id=a.athlete_id AND r.id=a.resource_id
      WHERE a.storage_ref=object_ref AND r.deleted_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.resource_url_ingestion i WHERE object_ref IN (i.raw_temporary_ref,i.raw_storage_ref,i.parsed_temporary_ref,i.parsed_storage_ref)
      AND (i.state IN ('queued','fetching','parsing') OR (i.state='failed' AND i.failure_retryable))
      AND i.expires_at>database_now)
  THEN UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,lease_until=NULL,
      delete_authorized_at=NULL,last_error_code='REFERENCE_PRESENT' WHERE q.id=$1; RETURN; END IF;
  RETURN QUERY UPDATE public.resource_object_cleanup q SET delete_authorized_at=database_now
    WHERE q.id=$1 RETURNING q.id,q.storage_ref,q.attempts;
END $$;
REVOKE ALL ON FUNCTION public.authorize_resource_object_cleanup(uuid,uuid,timestamptz) FROM PUBLIC;

-- Account-erasure cleanup receipts remain active deletion fences for the same thirty-day period
-- used by cleanup history. Repeated successful deletes cover late external publication and make an
-- older cleanup worker's finish unable to permanently close the fence.
CREATE OR REPLACE FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer; DECLARE database_now timestamptz:=clock_timestamp();
BEGIN
  UPDATE public.resource_object_cleanup SET
    completed_at=CASE
      WHEN $3 AND NOT (reason='account_erased' AND created_at>database_now-interval '30 days')
      THEN database_now ELSE NULL END,
    available_at=CASE
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days'
      THEN database_now+interval '1 hour'
      WHEN $3 THEN available_at
      ELSE database_now+least(attempts,10)*interval '30 seconds' END,
    attempts=CASE
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days' THEN 0
      ELSE attempts END,
    last_error_code=CASE
      WHEN $3 AND reason='account_erased' AND created_at>database_now-interval '30 days'
      THEN 'ERASURE_FENCE_ACTIVE'
      WHEN $3 THEN NULL
      WHEN attempts>=100 THEN 'DEAD_LETTER:'||left(coalesce($4,'OBJECT_DELETE_FAILED'),88)
      ELSE left(coalesce($4,'OBJECT_DELETE_FAILED'),100) END,
    lease_owner=NULL,lease_until=NULL,delete_authorized_at=NULL
  WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL AND lease_until>database_now
    AND delete_authorized_at IS NOT NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) FROM PUBLIC;

ALTER FUNCTION public.erase_account(text) RENAME TO erase_account_before_url_resources;
REVOKE ALL ON FUNCTION public.erase_account_before_url_resources(text) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT pg_get_userbyid(a.grantee)
    FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.erase_account_before_url_resources(text)'::regprocedure
      AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.erase_account_before_url_resources(text) FROM %I',role_name); END LOOP;
END $$;
CREATE FUNCTION public.erase_account(text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE erased_at timestamptz;
BEGIN
  IF $1 IS DISTINCT FROM nullif(current_setting('app.athlete_id',true),'') THEN RAISE EXCEPTION 'ERASURE_TENANT_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended($1,77206));
  UPDATE public.resource_url_ingestion SET state='cancelled',failure_code='ACCOUNT_ERASED',lease_owner=NULL,
    lease_token=NULL,lease_until=NULL,failure_phase=NULL,failure_retryable=false,failed_at=NULL,retry_at=NULL,
    updated_at=clock_timestamp()
    WHERE athlete_id=$1
      AND (state IN ('queued','fetching','parsing') OR (state='failed' AND failure_retryable));
  UPDATE public.resource_url_ingestion_attempt a SET status='failed',failure_code='ACCOUNT_ERASED',
    completed_at=clock_timestamp() FROM public.resource_url_ingestion i
    WHERE i.athlete_id=$1 AND a.athlete_id=i.athlete_id AND a.request_id=i.request_id
      AND a.status='running';
  INSERT INTO public.resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
    SELECT gen_random_uuid(),refs.storage_ref,'account_erased',clock_timestamp(),clock_timestamp() FROM (
      SELECT storage_ref FROM public.resource_object WHERE athlete_id=$1
      UNION SELECT x.storage_ref FROM public.resource_upload_intent i
        CROSS JOIN LATERAL (VALUES(i.temporary_ref),(i.storage_ref)) x(storage_ref)
        WHERE i.athlete_id=$1 AND x.storage_ref IS NOT NULL
      UNION SELECT storage_ref FROM public.resource_url_artifact WHERE athlete_id=$1
      UNION SELECT x.storage_ref FROM public.resource_url_ingestion i
        CROSS JOIN LATERAL (VALUES(i.raw_temporary_ref),(i.raw_storage_ref),(i.parsed_temporary_ref),(i.parsed_storage_ref)) x(storage_ref)
        WHERE i.athlete_id=$1 AND x.storage_ref IS NOT NULL
    ) refs ON CONFLICT(storage_ref) DO UPDATE SET id=EXCLUDED.id,reason=EXCLUDED.reason,attempts=0,
      lease_owner=NULL,lease_until=NULL,available_at=EXCLUDED.available_at,created_at=EXCLUDED.created_at,
      completed_at=NULL,delete_authorized_at=NULL,last_error_code=NULL;
  erased_at:=public.erase_account_before_url_resources($1);
  DELETE FROM public.resource_url_ingestion WHERE athlete_id=$1;
  RETURN erased_at;
END $$;
REVOKE ALL ON FUNCTION public.erase_account(text) FROM PUBLIC;
