-- Explicit bounded lossless parent response, never a permission/approval seal.
-- Actual post14124 metadata artifact SHA 0d1a47a090572a9da1525ec0e17b52b42a1955d2d0aa4ff247a093a5decf449e.
-- Independently actual baseline guard4 artifact SHA 21b2c7936ddc918bcaf44a228eef0809c4b0a5695002995c80e9e9433b331625.
-- Historical SQL134..141 functions/tables/receipts/ACLs remain unchanged.
DO $migration$
DECLARE original pg_catalog.pg_proc%ROWTYPE; observed pg_catalog.pg_proc%ROWTYPE;
 owner_oid oid; dependency record; protected_oids oid[]:=ARRAY[]::oid[];
 before_roster jsonb; after_roster jsonb; helper_meta jsonb; reader_meta jsonb; helper_body text; reader_body text; new_oid oid;
BEGIN
 IF current_user<>session_user OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT relowner INTO STRICT owner_oid FROM pg_class WHERE oid='public.manual_race_chain_commit_v2'::regclass;
 IF owner_oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
 OR NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='wm_manual_pooled' AND n.nspowner=owner_oid
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>owner_oid))
 OR NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND (n.nspowner=owner_oid OR n.nspowner=(SELECT oid FROM pg_roles WHERE rolname='pg_database_owner') AND EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=owner_oid))
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee NOT IN (owner_oid,n.nspowner) AND a.privilege_type='CREATE'))
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_NAMESPACE_INVALID'; END IF;
 IF to_regprocedure('public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wm_manual_pooled' AND p.proname='parent_delta_node_v1')
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_ALREADY_INSTALLED'; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wm_manual_pooled')<>12
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_PRIVATE_ROSTER_INVALID'; END IF;
 FOR dependency IN SELECT * FROM (VALUES
('public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','e21ba72f44e2cdf563d3a8a7b7c9f1c6b0e51877db9ab7be12e13f6bfd6bc4ff','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"store_manual_race_pooled_chain_v1","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["evidence_id","decision_id","proposal_id","receipt_key","request","payload","basis","lifecycle"],"proargtypes":["2950","2950","2950","25","3802","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)','d1b54a97a1c3474d8d5c416dc9bdaeb2337eadac91bcd2830c24e7d0028e83c7','plpgsql','void',false,'{"probin":null,"procost":100,"prokind":"f","proname":"validate_race_manual_pooled_application_basis_v1","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["retained","basis","lifecycle"],"proargtypes":["3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.read_manual_race_pooled_chain_v1(uuid)','f784d2489f73d8ab0abcbae155da78d06ab6d15bb78cfedd7ac3d8ceab058845','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"read_manual_race_pooled_chain_v1","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["evidence_id"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)','6aa33358717089873f595aefba8d233a2104e2c6a96cb0cd9f7dbf9f0d7172c4','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"ack_manual_race_pooled_same_tx_parent_v1","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["evidence","decision","proposal","readonly_digest","expected_retained"],"proargtypes":["2950","2950","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.race_manual_pooled_relative_membership_v1(jsonb)','a590a7597091c30e3d2b0bcc92ffb3c1ffee7c58d09c984957e068e9a5505687','plpgsql','void',false,'{"probin":null,"procost":100,"prokind":"f","proname":"race_manual_pooled_relative_membership_v1","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["retained"],"proargtypes":["3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.race_manual_pooled_routine_expansion_v1(jsonb,jsonb,jsonb,text)','6a32c5e54b3e204e2e4af0e8829beb1675bd41387d041aa588b1261b3a306fdf','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"race_manual_pooled_routine_expansion_v1","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["retained","projected","schedule","source_id"],"proargtypes":["3802","3802","3802","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.race_manual_pooled_validate_recipes_v1(jsonb,jsonb)','7c8cc6bfdcc9ee27de8d2430f81e399080b25649c3a43207d289b699f29dbb66','plpgsql','void',false,'{"probin":null,"procost":100,"prokind":"f","proname":"race_manual_pooled_validate_recipes_v1","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["candidate","retained"],"proargtypes":["3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)','f2d6e04df35f304b6e66ee457bff72429bd23d18af00879d7ba28cd53c03b7d0','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"prepare_race_manual_pooled_application_v1","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["candidate","basis","retained","lifecycle"],"proargtypes":["3802","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)','2a16d60ad9e74d6fd43d88353b399bc7d3e27a031836225e0eb0cd5a97e74f05','plpgsql','uuid',false,'{"probin":null,"procost":100,"prokind":"f","proname":"begin_race_manual_pooled_application_v1","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["command","basis","retained","lifecycle"],"proargtypes":["3802","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid)','63466e68cd2c8f0be7cc6e14b935535b3daff48e838f6f17da755e36ed78851b','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"finish_race_manual_pooled_public_review_v1","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["key","command","candidate"],"proargtypes":["25","3802","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.read_race_manual_pooled_public_preview_source_v1(uuid)','46299cca3e89a11d19ff5104d653e9ac0f93cdb99c8ab8b7f1df649c328a96ba','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"read_race_manual_pooled_public_preview_source_v1","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["candidate"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.read_manual_race_pooled_personal_export_batch_v1(integer)','9007410b714a09d7093c4b5eacd7d7326bd450b6f0f22524178cf9d7ae24d6df','plpgsql','jsonb',false,'{"probin":null,"procost":100,"prokind":"f","proname":"read_manual_race_pooled_personal_export_batch_v1","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["byte_limit"],"proargtypes":["23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.assert_owner()','9924268629b85961a0ec32398bdbd8745746c419bb05ad739f6ce9befaa601f7','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"assert_owner","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.exact_keys(jsonb,text[])','9c1b8e95b74508d1fa33c013610cb0496cdfc78a6b1220cac5d9b63e57da4aa2','sql','boolean',true,'{"probin":null,"procost":100,"prokind":"f","proname":"exact_keys","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["v","k"],"proargtypes":["3802","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.path_parts(text,boolean)','a56655e900f4bd211b9b5c27356bb37eb5fbdcb9d97197075f2e0cbea9817cdf','plpgsql','text[]',true,'{"probin":null,"procost":100,"prokind":"f","proname":"path_parts","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"1009","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["v","allow_root"],"proargtypes":["25","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1}'::jsonb),
('wm_manual_pooled.at_exact(jsonb,text[])','9c0f04724dbef25fedb8f2f3248d425897301d09c587bfaff6cabe1f65428994','plpgsql','jsonb',true,'{"probin":null,"procost":100,"prokind":"f","proname":"at_exact","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["v","p"],"proargtypes":["3802","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.check_encoded(jsonb)','d54fb68ffbaf44eab7a6956e21f16cecb5a103efef125b20976d752e9cd3f4e0','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"check_encoded","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["e"],"proargtypes":["3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.lookup(jsonb,text)','f27c360738286816fee3b744c9bbbc417394a14c02c17ddffcb746ab9894ebb7','plpgsql','jsonb',true,'{"probin":null,"procost":100,"prokind":"f","proname":"lookup","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["e","path"],"proargtypes":["3802","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.read_internal_export_v2(integer)','73e020f790197b8c4a3b39e9d51a5f79aa7b7ddcc3898760f605852a543a9d99','plpgsql','jsonb',true,'{"probin":null,"procost":100,"prokind":"f","proname":"read_internal_export_v2","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["byte_limit"],"proargtypes":["23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.read_public_export_metadata_v2(integer)','f8bf0820d46f446979e7ad359d248f7ff3df52292f59eb8c8eb7d2b5bcc5b587','plpgsql','jsonb',true,'{"probin":null,"procost":100,"prokind":"f","proname":"read_public_export_metadata_v2","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC","DateStyle=ISO,YMD"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["byte_limit"],"proargtypes":["23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.lookup_validated_local(jsonb,text)','9af916337f6a2f31ded78ab541b320245947ec3e38900d77cf05ecc8380d0527','plpgsql','jsonb',true,'{"probin":null,"procost":100,"prokind":"f","proname":"lookup_validated_local","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["e","path"],"proargtypes":["3802","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.relative_membership_validated_local_v1(jsonb)','ba5f652c5e8607404ec00d750f13c1ca1c1de070705870d52ae19dbce746213c','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"relative_membership_validated_local_v1","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["retained"],"proargtypes":["3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.routine_expansion_validated_local_v1(jsonb,jsonb,jsonb,text)','09918e5fa3ddd375d7f5aacdb01ca8e3687a8de0edd0d78198138d292de260ff','plpgsql','jsonb',true,'{"probin":null,"procost":100,"prokind":"f","proname":"routine_expansion_validated_local_v1","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, pg_temp","TimeZone=UTC"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["retained","projected","schedule","source_id"],"proargtypes":["3802","3802","3802","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('wm_manual_pooled.validate_recipes_validated_local_v1(jsonb,jsonb)','70d47fb4f649baf555acafe6c872c72d8bc81a04fc8fd0ffe265644a190202f9','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"validate_recipes_validated_local_v1","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["candidate","retained"],"proargtypes":["3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb)
,
('public.assert_manual_race_v2_caller()','94fe931526ec9a6926bdd7eda5055ab0ebda0560224626af454d4b06837ae348','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"assert_manual_race_v2_caller","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.manual_race_v2_assert_json_bound(jsonb)','eddb8a3273e013884e6400bf00bc8cf7d3a03d49edacad80d7f57b526113f2cb','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"manual_race_v2_assert_json_bound","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["body"],"proargtypes":["3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.assert_manual_review_global_lock()','6e353607c9be44e4fb4af3e6bdea0c3fa37d7b3a141e88b6f41ddd8eacb68507','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"assert_manual_review_global_lock","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('public.assert_manual_review_lifecycle_lock(text)','61b1e390437aac9946ac4c095aa6ff75bc6fc7b992e09bb600994efe11d7aae7','plpgsql','void',true,'{"probin":null,"procost":100,"prokind":"f","proname":"assert_manual_review_lifecycle_lock","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["tenant"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb)
 ) pins(signature,body_sha,language,result_type,private_helper,metadata) LOOP
 SELECT * INTO original FROM pg_proc WHERE oid=to_regprocedure(dependency.signature);
 IF NOT FOUND THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_PREDECESSOR_MISSING'; END IF;
 IF encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>dependency.body_sha OR original.proowner<>owner_oid
 OR original.pronamespace<>(SELECT oid FROM pg_namespace WHERE nspname=split_part(dependency.signature,'.',1))
 OR original.prolang<>(SELECT oid FROM pg_language WHERE lanname=dependency.language)
 OR pg_get_function_result(original.oid)<>dependency.result_type
 OR (to_jsonb(original)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc']) IS DISTINCT FROM dependency.metadata
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(original.proacl,acldefault('f',original.proowner))) a
 WHERE a.grantee=0 OR a.grantee<>owner_oid AND (a.is_grantable OR dependency.private_helper))
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_PREDECESSOR_DRIFT'; END IF;
 protected_oids:=array_append(protected_oids,original.oid);
 END LOOP;
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO before_roster FROM pg_proc p WHERE p.oid=ANY(protected_oids);
 SELECT to_jsonb(p) INTO STRICT helper_meta FROM pg_proc p WHERE p.oid='wm_manual_pooled.lookup_validated_local(jsonb,text)'::regprocedure;
 SELECT to_jsonb(p) INTO STRICT reader_meta FROM pg_proc p WHERE p.oid='public.read_manual_race_pooled_chain_v1(uuid)'::regprocedure;
 helper_body:=$helper$
DECLARE child jsonb; nodes integer:=1; entries jsonb:='[]'; k text; i integer; node jsonb; keys_base text[]; keys_parent text[];
BEGIN
 PERFORM wm_manual_pooled.assert_owner();
 IF $3 IS NULL OR $3<0 OR $3>64 OR $4 IS NULL OR $4<1 OR $4>5000 OR $1 IS NULL OR $2 IS NULL
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_BOUND'; END IF;
 IF $1=$2 THEN RETURN jsonb_build_object('node',jsonb_build_object('kind','same'),'nodes',1); END IF;
 IF jsonb_typeof($1)=jsonb_typeof($2) AND jsonb_typeof($2)='object' THEN
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys_base FROM jsonb_object_keys($1) AS keys(key);
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys_parent FROM jsonb_object_keys($2) AS keys(key);
  IF keys_base IS NOT DISTINCT FROM keys_parent THEN
   FOREACH k IN ARRAY coalesce(keys_parent,ARRAY[]::text[]) LOOP
    child:=wm_manual_pooled.parent_delta_node_v1($1->k,$2->k,$3+1,$4-nodes);
    nodes:=nodes+(child->>'nodes')::integer;
    entries:=entries||jsonb_build_array(jsonb_build_object('key',k,'node',child->'node'));
   END LOOP;
   node:=jsonb_build_object('kind','object','entries',entries);
  END IF;
 ELSIF jsonb_typeof($1)=jsonb_typeof($2) AND jsonb_typeof($2)='array' AND jsonb_array_length($1)=jsonb_array_length($2) THEN
  IF jsonb_array_length($2)>0 THEN
   FOR i IN 0..jsonb_array_length($2)-1 LOOP
    child:=wm_manual_pooled.parent_delta_node_v1($1->i,$2->i,$3+1,$4-nodes);
    nodes:=nodes+(child->>'nodes')::integer;
    entries:=entries||jsonb_build_array(child->'node');
   END LOOP;
  END IF;
  node:=jsonb_build_object('kind','array','items',entries);
 END IF;
 IF node IS NULL OR octet_length(node::text)>=octet_length(jsonb_build_object('kind','literal','value',$2)::text) THEN
  node:=jsonb_build_object('kind','literal','value',$2); nodes:=1;
 END IF;
 IF nodes>$4 OR octet_length(node::text)>4194304 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_BOUND'; END IF;
 RETURN jsonb_build_object('node',node,'nodes',nodes);
END
$helper$;
 EXECUTE 'CREATE FUNCTION wm_manual_pooled.parent_delta_node_v1(base jsonb,parent jsonb,depth integer,node_budget integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS '||quote_literal(helper_body);
 REVOKE ALL ON FUNCTION wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer) FROM PUBLIC;
 new_oid:='wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)'::regprocedure;
 SELECT * INTO STRICT observed FROM pg_proc WHERE oid=new_oid;
 IF observed.proowner<>owner_oid OR observed.prosecdef OR observed.prosrc<>helper_body OR observed.provolatile<>'s'
 OR observed.prokind<>'f' OR observed.proisstrict OR observed.proleakproof OR observed.proparallel<>'u'
 OR observed.prorettype<>'jsonb'::regtype OR observed.proretset OR observed.pronargs<>4
 OR observed.proargtypes<>'3802 3802 23 23'::oidvector OR observed.proargnames IS DISTINCT FROM ARRAY['base','parent','depth','node_budget']::text[]
 OR observed.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR observed.pronamespace<>'wm_manual_pooled'::regnamespace
 OR observed.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR (to_jsonb(observed)-ARRAY['oid','proname','prosrc','proacl','pronargs','proargtypes','proargnames']) IS DISTINCT FROM (helper_meta-ARRAY['oid','proname','prosrc','proacl','pronargs','proargtypes','proargnames'])
 OR observed.proargdefaults IS NOT NULL OR observed.pronargdefaults<>0 OR observed.provariadic<>0
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(observed.proacl,acldefault('f',observed.proowner))) a WHERE a.grantee<>owner_oid)
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_HELPER_METADATA'; END IF;
 reader_body:=$reader$
DECLARE t text:=nullif(current_setting('app.athlete_id',true),''); parent record; encoding text; delta jsonb; response jsonb;
BEGIN
 PERFORM public.assert_manual_race_v2_caller();
 IF t IS NULL OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN RAISE EXCEPTION 'MANUAL_CHAIN_SNAPSHOT_REQUIRED'; END IF;
 PERFORM public.assert_manual_review_global_lock(); PERFORM public.assert_manual_review_lifecycle_lock(t);
 PERFORM pg_advisory_xact_lock(hashtextextended(t,0));
 IF $1 IS NULL OR $2 IS NULL THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_INPUT'; END IF;
 -- This input is only a compression dictionary, never a current permission seal.
 -- Its full encoding and ownership are checked independently of the stored row.
 PERFORM public.manual_race_v2_assert_json_bound($2);
 PERFORM wm_manual_pooled.check_encoded($2);
 IF (wm_manual_pooled.lookup_validated_local($2,'context.athleteId')#>>'{}') IS DISTINCT FROM t
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_INPUT'; END IF;
 SELECT e.payload,r.result,e.purged_at,e.purged_event_id INTO parent
 FROM public.manual_race_evidence_v2 e JOIN public.manual_race_chain_receipt_v2 r ON r.athlete_id=e.athlete_id AND r.evidence_id=e.id
 WHERE e.athlete_id=t AND e.id=$1
 AND NOT EXISTS(SELECT 1 FROM public.tenant_erasure z WHERE z.athlete_id=e.athlete_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF parent.payload IS NULL THEN
  RETURN jsonb_build_object('readerVersion',1,'parentDeltaVersion',1,'schemaVersion',2,'result',parent.result,
   'payloadEncoding',NULL,'baseDigestMethod',NULL,'baseSqlDigest',NULL,'parentDigestMethod',NULL,'parentSqlDigest',NULL,
   'delta',NULL,'deltaNodes',0,'purgedAt',parent.purged_at,'purgedEventId',parent.purged_event_id);
 END IF;
 IF octet_length(parent.payload::text)>4194304 THEN RAISE EXCEPTION 'POOLED_CHAIN_READ_BOUND'; END IF;
 PERFORM public.manual_race_v2_assert_json_bound(parent.payload);
 IF parent.payload->'payload'->'preparation' ?| ARRAY['encoding','encodingVersion','skeleton','sourcePool','substitutions','logicalValidationProfile','logicalDigestMethod','logicalDigest'] THEN
  PERFORM wm_manual_pooled.check_encoded(parent.payload); encoding:='pooled-database-envelope-v1';
 ELSE
  IF NOT wm_manual_pooled.exact_keys(parent.payload->'payload'->'preparation',ARRAY['context','sourceInput','candidate'])
   OR jsonb_typeof(parent.payload->'payload'->'preparation'->'context') IS DISTINCT FROM 'object'
   OR jsonb_typeof(parent.payload->'payload'->'preparation'->'sourceInput') IS DISTINCT FROM 'object'
   OR jsonb_typeof(parent.payload->'payload'->'preparation'->'candidate') IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'POOLED_CHAIN_READ_ENCODING'; END IF;
  encoding:='legacy-retained-v2';
 END IF;
 delta:=wm_manual_pooled.parent_delta_node_v1($2,parent.payload,0,5000);
 response:=jsonb_build_object('readerVersion',1,'parentDeltaVersion',1,'schemaVersion',2,'result',parent.result,
  'payloadEncoding',encoding,'baseDigestMethod','postgres-jsonb-v1','baseSqlDigest',encode(sha256(convert_to($2::text,'UTF8')),'hex'),
  'parentDigestMethod','postgres-jsonb-v1','parentSqlDigest',encode(sha256(convert_to(parent.payload::text,'UTF8')),'hex'),
  'delta',delta->'node','deltaNodes',(delta->>'nodes')::integer,'purgedAt',parent.purged_at,'purgedEventId',parent.purged_event_id);
 IF octet_length(response::text)>4194304 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_BOUND'; END IF;
 PERFORM public.manual_race_v2_assert_json_bound(response);
 RETURN response;
END
$reader$;
 EXECUTE 'CREATE FUNCTION public.read_manual_race_pooled_parent_delta_v1(evidence_id uuid,fresh_encoded jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '||quote_literal(reader_body);
 REVOKE ALL ON FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) FROM PUBLIC;
 new_oid:='public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)'::regprocedure;
 SELECT * INTO STRICT observed FROM pg_proc WHERE oid=new_oid;
 IF observed.proowner<>owner_oid OR NOT observed.prosecdef OR observed.prosrc<>reader_body OR observed.provolatile<>'v'
 OR observed.prokind<>'f' OR observed.proisstrict OR observed.proleakproof OR observed.proparallel<>'u'
 OR observed.prorettype<>'jsonb'::regtype OR observed.proretset OR observed.pronargs<>2
 OR observed.proargtypes<>'2950 3802'::oidvector OR observed.proargnames IS DISTINCT FROM ARRAY['evidence_id','fresh_encoded']::text[]
 OR observed.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR observed.pronamespace<>'public'::regnamespace
 OR observed.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR (to_jsonb(observed)-ARRAY['oid','proname','prosrc','proacl','pronargs','proargtypes','proargnames']) IS DISTINCT FROM (reader_meta-ARRAY['oid','proname','prosrc','proacl','pronargs','proargtypes','proargnames'])
 OR observed.proargdefaults IS NOT NULL OR observed.pronargdefaults<>0 OR observed.provariadic<>0
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(observed.proacl,acldefault('f',observed.proowner))) a WHERE a.grantee<>owner_oid)
 THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_READER_METADATA'; END IF;
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO after_roster FROM pg_proc p WHERE p.oid=ANY(protected_oids);
 IF before_roster IS DISTINCT FROM after_roster THEN RAISE EXCEPTION 'POOLED_PARENT_DELTA_PREDECESSOR_CHANGED'; END IF;
END $migration$;
