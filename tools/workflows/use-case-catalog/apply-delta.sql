CREATE OR REPLACE FUNCTION catalog_apply_delta(catalog_table text, links_table text, delta jsonb, id_prefix text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  rec jsonb;
  rid text;
  slugtxt text;
  ttl text;
  jb text;
  pub boolean;
  covered boolean;
  plain_job_fails boolean;
  new_id text;
  n int;
  n_linked int := 0;
  n_new int := 0;
  n_internal int := 0;
  n_gaps int := 0;
BEGIN
  IF catalog_table !~ '^[a-z0-9_]+$' OR links_table !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'table names must be lowercase words';
  END IF;
  FOR rec IN SELECT * FROM jsonb_array_elements(delta) LOOP
    rid := rec->>'recipe';
    ttl := coalesce(rec->>'title', '');
    jb := coalesce(rec->>'job', '');
    pub := coalesce((rec->>'is_public')::boolean, false);
    slugtxt := substring(rid from 10);

    EXECUTE format('INSERT INTO %I (use_case_id, recipe, kind, basis, score, matched) SELECT u.id, $1::text, ''linked'', ''marketplace-url-slug equals recipe name'', 1, $2::text FROM %I u WHERE u.marketplace ~ $3::text ON CONFLICT (use_case_id, recipe) DO UPDATE SET kind = ''linked'', basis = EXCLUDED.basis, score = EXCLUDED.score, matched = EXCLUDED.matched, linked_at = now()', links_table, catalog_table)
      USING rid, slugtxt, '/marketplace/workflow/' || slugtxt || '$';
    GET DIAGNOSTICS n = ROW_COUNT;
    n_linked := n_linked + n;
    EXECUTE format('UPDATE %I u SET uses = u.uses || jsonb_build_array($1::text) WHERE u.marketplace ~ $2::text AND NOT (u.uses @> jsonb_build_array($1::text))', catalog_table)
      USING rid, '/marketplace/workflow/' || slugtxt || '$';

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I u WHERE u.uses @> jsonb_build_array($1::text)) OR EXISTS (SELECT 1 FROM %I l WHERE l.recipe = $1::text AND l.kind IN (''linked'', ''new-row''))', catalog_table, links_table)
      INTO covered USING rid;
    CONTINUE WHEN covered;

    plain_job_fails := (ttl || ' ' || regexp_replace(slugtxt, '-', ' ', 'g')) ~* '\m(pursuits?|modes?|mechanisms?|observations?|segments?|outcomes?|memory|derive|compress|method|kept|rows?|commit|component|workflows?|database|models?|tools?|agents?|skills?|approach|shared|items|sign-?ins?|signs? in|stages? by)\M'
      OR jb ~ '^(How|What|Why|Whether)' OR (ttl || jb) LIKE '%?%'
      OR (ttl || ' ' || jb) !~* '\m(person|people|persons|owner|owners|seller|sellers|customers?|buyers?|business|anyone|someone|students?|creators?|fans?|family|company|companies|store|team|brand|shop|founder|clients?|readers?|viewers?|you|your|reader|members?|audience|users?|workers?|parents?|artists?|musicians?|teachers?|coach|subscribers?|who|booker|guests?)\M';

    IF NOT pub OR rid ~ '(router|reader|wake|notice|row-change|route-each|choose-the-workflows|step-[0-9]|sweep|changelog)'
       OR rid LIKE 'workflow:path:%' OR rid LIKE 'workflow:method-%' OR plain_job_fails THEN
      EXECUTE format('INSERT INTO %I (use_case_id, recipe, kind, basis) VALUES ('''', $1::text, ''internal'', ''not public, plumbing, or failed the plain-job rule'') ON CONFLICT (use_case_id, recipe) DO NOTHING', links_table)
        USING rid;
      GET DIAGNOSTICS n = ROW_COUNT;
      n_internal := n_internal + n;
    ELSE
      new_id := id_prefix || slugtxt;
      EXECUTE format('INSERT INTO %I (id, title, job, uses, checked) SELECT $1::text, $2::text, $3::text, jsonb_build_array($4::text), to_char(now(), ''YYYY-MM-DD'') WHERE NOT EXISTS (SELECT 1 FROM %I x WHERE x.id = $1::text)', catalog_table, catalog_table)
        USING new_id, ttl, jb, rid;
      EXECUTE format('INSERT INTO %I (use_case_id, recipe, kind, basis, score) VALUES ($1::text, $2::text, ''new-row'', ''public workflow with no use-case row'', 1) ON CONFLICT (use_case_id, recipe) DO NOTHING', links_table)
        USING new_id, rid;
      GET DIAGNOSTICS n = ROW_COUNT;
      n_new := n_new + n;
    END IF;
  END LOOP;

  EXECUTE format('DELETE FROM %I g WHERE g.kind = ''gap'' AND EXISTS (SELECT 1 FROM %I l WHERE l.use_case_id = g.use_case_id AND l.kind IN (''linked'', ''new-row''))', links_table, links_table);
  EXECUTE format('INSERT INTO %I (use_case_id, recipe, kind, basis) SELECT u.id, '''', ''gap'', CASE WHEN u.marketplace LIKE ''%%/tool/%%'' THEN ''marketplace tool or no workflow match'' ELSE ''no workflow matched'' END FROM %I u WHERE u.id IS NOT NULL AND u.uses::text NOT LIKE ''%%workflow:%%'' AND NOT EXISTS (SELECT 1 FROM %I l WHERE l.use_case_id = u.id AND l.kind IN (''linked'', ''new-row'')) ON CONFLICT (use_case_id, recipe) DO NOTHING', links_table, catalog_table, links_table);
  GET DIAGNOSTICS n_gaps = ROW_COUNT;

  RETURN jsonb_build_object('linked_touched', n_linked, 'new_rows', n_new, 'internal', n_internal, 'gaps_added', n_gaps);
END;
$fn$;
