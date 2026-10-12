-- Unregistered pure parser asset. No operational table, admission or runtime grant.
-- Same strict subset as server-media/gallery-webvtt user-webvtt-plain-v1.
CREATE FUNCTION public.parse_gallery_webvtt_v1(raw bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER IMMUTABLE SET search_path=pg_catalog AS $function$
DECLARE
  size integer; i integer:=0; b integer; c integer; width integer; point integer;
  minimum integer; invalid_character boolean:=false; text_value text; lines text[];
  line_count integer; cursor_line integer:=3; first_line text; identifier text;
  identifiers text[]:=ARRAY[]::text[]; timing text; parts text[]; stamp text;
  stamps bigint[]; value numeric; start_ms bigint; end_ms bigint; previous_ms bigint;
  payload text; decoded text; rest text; amp integer; token text; reference_value text;
  units integer; line_units integer; output_bytes integer; cue_count integer:=0;
  cues jsonb:='[]'::jsonb; cue_ids jsonb:='[]'::jsonb; cue jsonb; result jsonb;
  source_hash text; whitespace text:=E' \t\n\r\v\f'||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
  nonspace text; tail text; compact_cue text;
BEGIN
  size:=octet_length(raw);
  IF raw IS NULL OR size<1 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF size>524288 THEN RAISE EXCEPTION 'SOURCE_TOO_LARGE'; END IF;
  -- Validate UTF8 before control-character rejection, including NUL, which
  -- PostgreSQL text cannot represent. No replacement or invalid-byte recovery.
  WHILE i<size LOOP
    b:=get_byte(raw,i);
    IF b<128 THEN width:=1; point:=b; minimum:=0;
    ELSIF b BETWEEN 194 AND 223 THEN width:=2; point:=b-192; minimum:=128;
    ELSIF b BETWEEN 224 AND 239 THEN width:=3; point:=b-224; minimum:=2048;
    ELSIF b BETWEEN 240 AND 244 THEN width:=4; point:=b-240; minimum:=65536;
    ELSE RAISE EXCEPTION 'INVALID_UTF8'; END IF;
    IF i+width>size THEN RAISE EXCEPTION 'INVALID_UTF8'; END IF;
    FOR j IN 1..width-1 LOOP
      c:=get_byte(raw,i+j);
      IF c<128 OR c>191 THEN RAISE EXCEPTION 'INVALID_UTF8'; END IF;
      point:=point*64+c-128;
    END LOOP;
    IF point<minimum OR point>1114111 OR point BETWEEN 55296 AND 57343 THEN RAISE EXCEPTION 'INVALID_UTF8'; END IF;
    IF (point<32 AND point NOT IN (9,10,13)) OR point BETWEEN 127 AND 159 THEN invalid_character:=true; END IF;
    i:=i+width;
  END LOOP;
  IF invalid_character THEN RAISE EXCEPTION 'INVALID_CHARACTER'; END IF;
  text_value:=convert_from(raw,'UTF8');
  source_hash:=encode(public.digest(raw,'sha256'),'hex');
  IF left(text_value,1)=chr(65279) THEN text_value:=substr(text_value,2); END IF;
  text_value:=replace(replace(text_value,E'\r\n',E'\n'),E'\r',E'\n');
  line_count:=length(text_value)-length(replace(text_value,E'\n',''))+1;
  IF line_count>20000 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
  lines:=string_to_array(text_value,E'\n');
  IF lines[1] IS DISTINCT FROM 'WEBVTT' THEN
    IF left(lines[1],7) IN ('WEBVTT ',E'WEBVTT\t') THEN RAISE EXCEPTION 'UNSUPPORTED_HEADER_METADATA'; END IF;
    RAISE EXCEPTION 'INVALID_HEADER';
  END IF;
  IF lines[2] IS DISTINCT FROM '' THEN RAISE EXCEPTION 'INVALID_HEADER'; END IF;
  output_bytes:=octet_length('{"parserVersion":"user-webvtt-plain-v1","source":{"byteSize":'||size::text||',"sha256":"'||source_hash||'"},"cues":[],"cueIdentifiers":[]}');
  nonspace:='[^'||whitespace||']';
  WHILE cursor_line<=line_count LOOP
    first_line:=lines[cursor_line];
    IF first_line='' THEN cursor_line:=cursor_line+1; CONTINUE; END IF;
    IF cue_count>=1000 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
    IF first_line ~ E'^(STYLE|REGION|NOTE)([ \t]|$)' THEN RAISE EXCEPTION 'UNSUPPORTED_BLOCK'; END IF;
    identifier:=NULL; timing:=first_line;
    IF position('-->' IN first_line)=0 THEN
      identifier:=first_line;
      SELECT length(identifier)+count(*) FILTER(WHERE ascii(ch)>65535) INTO units FROM regexp_split_to_table(identifier,'') AS t(ch);
      IF units>2000 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
      IF identifier COLLATE "C"=ANY(identifiers) THEN RAISE EXCEPTION 'DUPLICATE_CUE_IDENTIFIER'; END IF;
      identifiers:=array_append(identifiers,identifier);
      cursor_line:=cursor_line+1;
      IF cursor_line>line_count THEN RAISE EXCEPTION 'INVALID_CUE'; END IF;
      timing:=lines[cursor_line];
    END IF;
    IF position(chr(8232) IN timing)>0 OR position(chr(8233) IN timing)>0 THEN RAISE EXCEPTION 'INVALID_TIMESTAMP'; END IF;
    parts:=regexp_match(timing,'^('||nonspace||'+)[ '||chr(9)||']+-->[ '||chr(9)||']+('||nonspace||'+)(.*)$');
    IF parts IS NULL THEN RAISE EXCEPTION 'INVALID_TIMESTAMP'; END IF;
    tail:=parts[3];
    IF btrim(tail,whitespace)<>'' THEN RAISE EXCEPTION 'UNSUPPORTED_CUE_SETTINGS'; END IF;
    stamps:=ARRAY[]::bigint[];
    FOR k IN 1..2 LOOP
      stamp:=parts[k];
      IF length(stamp)>32 THEN RAISE EXCEPTION 'INVALID_TIMESTAMP'; END IF;
      DECLARE fields text[];
      BEGIN
        fields:=regexp_match(stamp,'^(?:([0-9]{2,}):)?([0-5][0-9]):([0-5][0-9])[.]([0-9]{3})$');
        IF fields IS NULL THEN RAISE EXCEPTION 'INVALID_TIMESTAMP'; END IF;
        value:=coalesce(fields[1],'0')::numeric*3600000+fields[2]::numeric*60000+fields[3]::numeric*1000+fields[4]::numeric;
        IF value>9007199254740991 THEN RAISE EXCEPTION 'INVALID_TIMESTAMP'; END IF;
        stamps:=array_append(stamps,value::bigint);
      END;
    END LOOP;
    start_ms:=stamps[1]; end_ms:=stamps[2];
    cursor_line:=cursor_line+1; payload:=''; units:=0; i:=0;
    WHILE cursor_line<=line_count AND lines[cursor_line]<>'' LOOP
      SELECT length(lines[cursor_line])+count(*) FILTER(WHERE ascii(ch)>65535) INTO line_units FROM regexp_split_to_table(lines[cursor_line],'') AS t(ch);
      units:=units+line_units+CASE WHEN i>0 THEN 1 ELSE 0 END;
      IF units>2000 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
      payload:=payload||CASE WHEN i>0 THEN E'\n' ELSE '' END||lines[cursor_line];
      i:=i+1; cursor_line:=cursor_line+1;
    END LOOP;
    IF position('<' IN payload)>0 THEN RAISE EXCEPTION 'UNSUPPORTED_CUE_MARKUP'; END IF;
    IF position('-->' IN payload)>0 THEN RAISE EXCEPTION 'INVALID_CUE'; END IF;
    decoded:=''; rest:=payload;
    LOOP
      amp:=position('&' IN rest);
      IF amp=0 THEN decoded:=decoded||rest; EXIT; END IF;
      decoded:=decoded||left(rest,amp-1); rest:=substr(rest,amp);
      token:=substring(rest FROM '^&([^'||whitespace||'&;]*);?');
      reference_value:=CASE token WHEN 'amp' THEN '&' WHEN 'lt' THEN '<' WHEN 'gt' THEN '>' WHEN 'lrm' THEN chr(8206) WHEN 'rlm' THEN chr(8207) WHEN 'nbsp' THEN chr(160) END;
      IF reference_value IS NULL OR substr(rest,length(token)+2,1)<>';' THEN RAISE EXCEPTION 'UNSUPPORTED_CHARACTER_REFERENCE'; END IF;
      decoded:=decoded||reference_value; rest:=substr(rest,length(token)+3);
    END LOOP;
    IF end_ms<=start_ms OR decoded='' THEN RAISE EXCEPTION 'INVALID_CUE'; END IF;
    IF previous_ms IS NOT NULL AND start_ms<previous_ms THEN RAISE EXCEPTION 'CUE_ORDER_INVALID'; END IF;
    compact_cue:='{"startMs":'||start_ms::text||',"endMs":'||end_ms::text||',"text":'||to_json(decoded)::text||'}';
    output_bytes:=output_bytes+octet_length(compact_cue)+octet_length(coalesce(to_json(identifier)::text,'null'))+CASE WHEN cue_count>0 THEN 2 ELSE 0 END;
    IF output_bytes>524288 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
    cue:=jsonb_build_object('startMs',start_ms,'endMs',end_ms,'text',decoded);
    cues:=cues||jsonb_build_array(cue); cue_ids:=cue_ids||jsonb_build_array(identifier);
    cue_count:=cue_count+1; previous_ms:=start_ms;
  END LOOP;
  result:=jsonb_build_object('parserVersion','user-webvtt-plain-v1','source',jsonb_build_object('byteSize',size,'sha256',source_hash),'cues',cues,'cueIdentifiers',cue_ids);
  RETURN result;
END
$function$;
REVOKE ALL ON FUNCTION public.parse_gallery_webvtt_v1(bytea) FROM PUBLIC;
