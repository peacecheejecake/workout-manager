-- Narrow retained DB cleanup status. No external object-deletion assertion.
-- Unregistered staging migration: Root owns registry/retarget/EXECUTE integration.
CREATE FUNCTION public.read_race_media_cleanup(media uuid, expected_revision integer)
RETURNS TABLE(source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text:=nullif(current_setting('app.athlete_id',true),'');
DECLARE caller oid;
DECLARE owner_role oid;
DECLARE item record;
DECLARE ref record;
DECLARE ledger record;
DECLARE upload record;
DECLARE queue record;
DECLARE prefix text;
DECLARE parts text[];
DECLARE refs jsonb:='[]'::jsonb;
DECLARE result jsonb;
DECLARE complete boolean:=true;
DECLARE result_state text:='unavailable';
DECLARE result_reason text;
DECLARE observed integer;
DECLARE is_deleted boolean;
DECLARE ref_count integer:=0;
DECLARE pending_count integer:=0;
BEGIN
 SELECT oid INTO caller FROM pg_roles WHERE rolname=session_user;
 SELECT relowner INTO owner_role FROM pg_class WHERE oid='public.gallery_media_item'::regclass;
 IF current_user<>pg_get_userbyid(owner_role)
 OR EXISTS(SELECT 1 FROM pg_roles WHERE oid IN (caller,owner_role) AND (rolsuper OR rolbypassrls))
 OR caller=owner_role
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relowner=caller AND n.nspname IN ('public','identity_private') AND c.relkind IN ('r','p'))
 OR NOT has_function_privilege(session_user,'public.read_race_media_cleanup(uuid,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'RACE_MEDIA_READ_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM public.assert_manual_review_global_lock();
 PERFORM public.assert_manual_review_lifecycle_lock(tenant);
 IF tenant IS NULL OR tenant !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR NOT EXISTS(SELECT 1 FROM identity_private.account a WHERE a.athlete_id=tenant::uuid)
 OR EXISTS(SELECT 1 FROM public.tenant_erasure e WHERE e.athlete_id=tenant)
 THEN RAISE EXCEPTION 'RACE_MEDIA_READ_TENANT_REQUIRED' USING ERRCODE='42501'; END IF;
 IF media IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 1 AND 2147483647
 THEN RAISE EXCEPTION 'RACE_MEDIA_READ_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
 -- Same ordering/namespace as gallery producers: global -> lifecycle -> tenant0.
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant,0));
 SELECT m.* INTO item FROM public.gallery_media_item m
  WHERE m.athlete_id=tenant AND m.id=media FOR SHARE;
 IF NOT FOUND THEN result_reason:='OWNED_MEDIA_UNAVAILABLE'; complete:=false;
 ELSE
  observed:=item.access_revision; is_deleted:=item.deleted_at IS NOT NULL;
  IF observed<>expected_revision THEN result_reason:='ACCESS_REVISION_STALE'; complete:=false;
  ELSE
   prefix:='private/v1/tenants/'||tenant||'/gallery/'||media::text||'/';
   -- Only published objects with original finalized-upload and immutable ledger
   -- correspondence are supported. In-flight/failed or unaccounted historical
   -- objects are explicit unavailable, never a fabricated empty inventory.
   IF EXISTS(SELECT 1 FROM public.gallery_upload_intent u WHERE u.athlete_id=tenant
      AND u.media_item_id=media AND u.state<>'finalized')
    OR EXISTS(SELECT 1 FROM public.gallery_media_object o WHERE o.athlete_id=tenant
      AND left(o.storage_ref,length(prefix))=prefix
      AND o.storage_ref<>item.storage_ref
      AND NOT EXISTS(SELECT 1 FROM public.gallery_media_derivative d WHERE d.athlete_id=tenant
        AND d.media_item_id=media AND d.storage_ref=o.storage_ref))
    OR EXISTS(SELECT 1 FROM public.gallery_upload_intent u WHERE u.athlete_id=tenant
      AND u.media_item_id=media AND u.state='finalized'
      AND (u.storage_ref IS NULL OR (u.storage_ref<>item.storage_ref
        AND NOT EXISTS(SELECT 1 FROM public.gallery_media_derivative d WHERE d.athlete_id=tenant
          AND d.media_item_id=media AND d.storage_ref=u.storage_ref))))
   THEN complete:=false; result_reason:='INVENTORY_UNAVAILABLE';
   END IF;
   FOR ref IN
    SELECT k.storage_ref,k.content_hash,k.size_bytes,k.media_type FROM (
     SELECT item.storage_ref,item.content_hash,item.size_bytes,item.media_type
     UNION ALL SELECT d.storage_ref,d.content_hash,d.size_bytes,d.media_type
      FROM public.gallery_media_derivative d WHERE d.athlete_id=tenant AND d.media_item_id=media
    ) k ORDER BY k.storage_ref COLLATE "C" LIMIT 65
   LOOP
    ref_count:=ref_count+1;
    IF ref_count>64 THEN complete:=false; result_reason:='INVENTORY_UNAVAILABLE'; EXIT; END IF;
    parts:=regexp_match(ref.storage_ref,
     '^private/v1/tenants/('||tenant||')/gallery/('||media::text||')/objects/uploads/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(png|jpg|webp|mp4|webm)$');
    SELECT o.* INTO ledger FROM public.gallery_media_object o WHERE o.athlete_id=tenant AND o.storage_ref=ref.storage_ref;
    IF parts IS NULL OR ledger.storage_ref IS NULL OR ledger.content_hash<>ref.content_hash
      OR ledger.size_bytes<>ref.size_bytes OR ledger.media_type<>ref.media_type
      OR parts[4]<>ref.content_hash
      OR parts[5] IS DISTINCT FROM (CASE ref.media_type WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' WHEN 'video/mp4' THEN 'mp4' WHEN 'video/webm' THEN 'webm' END)
      OR ref.storage_ref IN (SELECT d.storage_ref FROM public.gallery_media_derivative d WHERE d.athlete_id=tenant AND d.media_item_id=media AND d.storage_ref=item.storage_ref)
    THEN complete:=false; result_reason:='INVENTORY_UNAVAILABLE';
    ELSE
     SELECT u.* INTO upload FROM public.gallery_upload_intent u WHERE u.athlete_id=tenant
      AND u.media_item_id=media AND u.upload_id=parts[3]::uuid AND u.state='finalized';
     IF upload.upload_id IS NULL OR upload.storage_ref IS DISTINCT FROM ref.storage_ref
      OR upload.content_hash IS DISTINCT FROM ref.content_hash OR upload.size_bytes IS DISTINCT FROM ref.size_bytes
      OR upload.media_type IS DISTINCT FROM ref.media_type
      OR upload.operation<>(CASE WHEN ref.storage_ref=item.storage_ref THEN 'create_item' ELSE 'attach_preview' END)
     THEN complete:=false; result_reason:='INVENTORY_UNAVAILABLE'; END IF;
    END IF;
    SELECT q.* INTO queue FROM public.resource_object_cleanup q WHERE q.storage_ref=ref.storage_ref;
    IF queue.id IS NULL THEN
     IF is_deleted THEN complete:=false; result_reason:=coalesce(result_reason,'QUEUE_TUPLE_UNAVAILABLE'); END IF;
     refs:=refs||jsonb_build_array(jsonb_build_object('digest',encode(sha256(convert_to('race-media-ref-v1'||chr(10)||ref.storage_ref,'UTF8')),'hex'),'reason',NULL,'state','absent'));
    ELSE
     IF queue.reason<>'resource_deleted' OR queue.last_error_code IS NOT NULL OR NOT is_deleted
     THEN complete:=false; result_reason:=coalesce(result_reason,CASE WHEN queue.last_error_code='REFERENCE_PRESENT' OR NOT is_deleted THEN 'REFERENCE_PRESENT' ELSE 'QUEUE_TUPLE_UNAVAILABLE' END);
      refs:=refs||jsonb_build_array(jsonb_build_object('digest',encode(sha256(convert_to('race-media-ref-v1'||chr(10)||ref.storage_ref,'UTF8')),'hex'),'reason',queue.reason,'state','unavailable'));
     ELSE
      IF queue.completed_at IS NULL THEN pending_count:=pending_count+1; END IF;
      refs:=refs||jsonb_build_array(jsonb_build_object('digest',encode(sha256(convert_to('race-media-ref-v1'||chr(10)||ref.storage_ref,'UTF8')),'hex'),'reason',queue.reason,'state',CASE WHEN queue.completed_at IS NULL THEN 'pending' ELSE 'completed' END));
     END IF;
    END IF;
   END LOOP;
   IF ref_count=0 THEN complete:=false; result_reason:='INVENTORY_UNAVAILABLE'; END IF;
   IF complete THEN result_state:=CASE WHEN NOT is_deleted THEN 'absent' WHEN pending_count>0 THEN 'pending' ELSE 'completed' END; END IF;
  END IF;
 END IF;
 result:=jsonb_build_object('schemaVersion',1,'authority','db_cleanup_status_only',
  'mediaItemId',media,'expectedAccessRevision',expected_revision,'observedAccessRevision',observed,'deleted',is_deleted,
  'inventoryComplete',complete,'state',result_state,'reason',result_reason,'refs',refs,'digestVersion','postgres-jsonb-v1');
 RETURN QUERY SELECT result||jsonb_build_object('sourceDigest',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.read_race_media_cleanup(uuid,integer) FROM PUBLIC;
