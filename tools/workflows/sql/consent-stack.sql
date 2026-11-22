-- Row-change stack for one pursuit database (unqualified names: the function writes row_changes through the search path): every table with a tell_row_change trigger writes its rows here.
CREATE SEQUENCE IF NOT EXISTS row_changes_position_seq;
CREATE TABLE IF NOT EXISTS row_changes (
  position bigint NOT NULL DEFAULT nextval('row_changes_position_seq'::regclass) PRIMARY KEY,
  txid xid8 DEFAULT pg_current_xact_id(),
  at timestamptz DEFAULT clock_timestamp(),
  table_name text,
  op text,
  before jsonb,
  after jsonb,
  changed_by text DEFAULT CURRENT_USER);
CREATE OR REPLACE FUNCTION public.record_row_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE kept bigint;
BEGIN
  BEGIN
    INSERT INTO row_changes (table_name, op, before, after) VALUES (TG_TABLE_NAME, TG_OP, CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END, CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END) RETURNING position INTO kept;
    PERFORM pg_notify('row_changes', kept::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'record_row_change: % (the % on % went through untold)', SQLERRM, TG_OP, TG_TABLE_NAME;
  END;
  RETURN NULL;
END $function$
;

-- Consent stack for one pursuit database: the tables and functions the fence reads. No grant or subject rows.
CREATE TABLE IF NOT EXISTS public."use_grants" (
  "id" text NOT NULL,
  "subject" text NOT NULL,
  "how" text DEFAULT ''::text NOT NULL,
  "purpose" text DEFAULT ''::text NOT NULL,
  "surface" text DEFAULT ''::text NOT NULL,
  "effect" text NOT NULL,
  "evidence" text NOT NULL,
  "given_at" timestamp with time zone NOT NULL,
  "withdrawn_at" timestamp with time zone,
  "holds_until" timestamp with time zone,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT ((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric))::bigint NOT NULL,
  CONSTRAINT "use_grants_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."material_subjects" (
  "id" bigint NOT NULL,
  "material" text NOT NULL,
  "span_start" numeric,
  "span_end" numeric,
  "subject" text NOT NULL,
  "how" text NOT NULL,
  "sure" real,
  "found_by" text NOT NULL,
  "found_at" timestamp with time zone DEFAULT now() NOT NULL,
  "derived_from" text,
  "made_by" text,
  CONSTRAINT "material_subjects_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public."material_prefix_rules" (
  "prefix" text NOT NULL,
  "shape" text NOT NULL,
  "why" text NOT NULL,
  CONSTRAINT "material_prefix_rules_pkey" PRIMARY KEY (prefix)
);

CREATE TABLE IF NOT EXISTS public."mentions" (
  "statement" bigint NOT NULL,
  "role" text NOT NULL,
  "scheme" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "mentions_pkey" PRIMARY KEY (statement, role, scheme, value)
);

CREATE TABLE IF NOT EXISTS public."statements" (
  "id" bigint NOT NULL,
  "source" text NOT NULL,
  "told" text NOT NULL,
  "place" text,
  "change" text,
  "at" timestamp with time zone NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "key" text,
  "before" jsonb,
  "after" jsonb,
  "detail" jsonb,
  "meaning" text,
  "retracts" bigint,
  "holds_from" timestamp with time zone,
  "holds_until" timestamp with time zone,
  "erased_at" timestamp with time zone,
  CONSTRAINT "statements_pkey" PRIMARY KEY (id),
  CONSTRAINT "statements_source_told_key" UNIQUE (source, told)
);

CREATE TABLE IF NOT EXISTS public."business_setup" (
  "id" text NOT NULL,
  "business_name" text,
  "candidates_not_filled" text,
  "chosen_for" text,
  "currency" text,
  "domain" text,
  "email_sending_domain" text,
  "first_offer_name" text,
  "first_offer_price_text" text,
  "no_source_found" text,
  "owner_email" text,
  "owner_name" text,
  "sources" text,
  "extra" text,
  "owner_names" text[] DEFAULT '{}'::text[] NOT NULL,
  CONSTRAINT "business_setup_pkey" PRIMARY KEY (id)
);

ALTER TABLE public.use_grants ADD COLUMN IF NOT EXISTS covers_below boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.surface_covers(p text, below boolean, v text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ select p = '' or v = p or (coalesce(below, false) and starts_with(v, p || '/')) $function$;

CREATE OR REPLACE FUNCTION public.covers(p text, v text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ select p = '' or v = p or starts_with(v, p || '/') or starts_with(v, p || ':') $function$;

CREATE OR REPLACE FUNCTION public.stands(id bigint, known timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT NOT EXISTS (SELECT 1 FROM statements x WHERE x.retracts = stands.id AND x.recorded_at <= stands.known) $function$;

CREATE OR REPLACE FUNCTION public.pair_allowed(s text, h text, pu text, su text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from use_grants g where g.effect = 'allow' and covers(g.subject, s) and covers(g.how, h)
                   and covers(g.purpose, pu) and surface_covers(g.surface, g.covers_below, su)
                   and g.given_at <= now() and (g.withdrawn_at is null or g.withdrawn_at > now())
                   and (g.holds_until is null or g.holds_until > now()))
  and not exists (select 1 from use_grants g where g.effect = 'deny' and covers(g.subject, s) and covers(g.how, h)
                   and covers(g.purpose, pu) and surface_covers(g.surface, g.covers_below, su)
                   and g.given_at <= now() and (g.withdrawn_at is null or g.withdrawn_at > now())
                   and (g.holds_until is null or g.holds_until > now()))
$function$;

CREATE OR REPLACE FUNCTION public.material_refusals(m text, a numeric, b numeric, pu text, su text)
 RETURNS TABLE(refused_subject text, refused_how text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with subjects as (
    select s.subject, s.how from material_subjects s
     where s.material = m
       and (a is null or s.span_end is null or s.span_end > a)
       and (b is null or s.span_start is null or s.span_start < b)
    union all
    select 'unexamined', 'unexamined' where not exists (select 1 from material_subjects s where s.material = m)
  )
  select distinct sb.subject, sb.how from subjects sb where not pair_allowed(sb.subject, sb.how, pu, su)
$function$;

CREATE OR REPLACE FUNCTION public.material_allowed(m text, a numeric, b numeric, pu text, su text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with subjects as (
    select s.subject, s.how from material_subjects s
     where s.material = m
       and (a is null or s.span_end is null or s.span_end > a)
       and (b is null or s.span_start is null or s.span_start < b)
    union all
    select 'unexamined', 'unexamined' where not exists (select 1 from material_subjects s where s.material = m)
  )
  select coalesce(bool_and(pair_allowed(subject, how, pu, su)), true) from subjects
$function$;

CREATE OR REPLACE FUNCTION public.material_pickable(candidates text[], pu text, su text)
 RETURNS TABLE(material text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m FROM unnest(coalesce(candidates, (SELECT array_agg(DISTINCT s.material) FROM material_subjects s), '{}')) m
   WHERE material_allowed(m, NULL, NULL, pu, su) ORDER BY m
$function$;

CREATE OR REPLACE FUNCTION public.post_people(caption text)
 RETURNS TABLE(subject text, via text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; k record;
BEGIN
  FOR r IN
    SELECT DISTINCT m.scheme, m.value FROM mentions m
     WHERE m.role = 'address' AND m.scheme IN ('email', 'handle', 'name') AND length(btrim(m.value, '@')) >= 3
       AND lower(coalesce(caption, '')) ~ ('(^|[^a-z0-9_])' || regexp_replace(lower(btrim(m.value, '@')), '([^a-z0-9 ])', E'\\\\\\1', 'g') || '([^a-z0-9_]|$)')
  LOOP
    subject := NULL;
    FOR k IN SELECT DISTINCT pm.value FROM mentions am
               JOIN statements st ON st.id = am.statement AND st.meaning = 'same-person' AND st.retracts IS NULL AND st.erased_at IS NULL
                AND coalesce(st.holds_from, '-infinity') <= now() AND coalesce(st.holds_until, 'infinity') > now() AND stands(st.id, now())
               JOIN mentions pm ON pm.statement = st.id AND pm.role = 'person' AND pm.scheme = 'person'
              WHERE am.role = 'address' AND am.scheme = r.scheme AND am.value = r.value LOOP
      subject := k.value; via := r.scheme || ' match'; RETURN NEXT;
    END LOOP;
    IF subject IS NULL THEN subject := r.scheme || ':' || r.value; via := r.scheme || ' match, no person known'; RETURN NEXT; END IF;
  END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.public_figure_cleared(who text, pu text, su text, p_use text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH n AS (SELECT replace(replace(lower(btrim(who)), '%', ''), '_', '') AS v),
  live AS (SELECT g.* FROM use_grants g, n
            WHERE n.v <> '' AND length(n.v) >= 4
              AND (g.subject = 'public-figure:' || n.v OR g.subject LIKE 'public-figure:% ' || n.v)
              AND covers(g.how, p_use) AND covers(g.purpose, pu) AND surface_covers(g.surface, g.covers_below, su)
              AND g.given_at <= now() AND (g.withdrawn_at IS NULL OR g.withdrawn_at > now())
              AND (g.holds_until IS NULL OR g.holds_until > now()))
  SELECT EXISTS (SELECT 1 FROM live WHERE effect = 'allow' AND evidence ~ '^https?://')
     AND NOT EXISTS (SELECT 1 FROM live WHERE effect = 'deny')
$function$;

DROP FUNCTION IF EXISTS public.public_figure_cleared(text, text, text);

CREATE OR REPLACE FUNCTION public.owner_named(who text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM business_setup b, unnest(b.owner_names) n
                  WHERE length(btrim(coalesce(who, ''))) >= 4 AND lower(btrim(n)) = lower(btrim(who)))
$function$;

CREATE OR REPLACE FUNCTION public.consent_stop(checked jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE bad text;
BEGIN
  IF jsonb_typeof(checked) IS DISTINCT FROM 'array' OR jsonb_array_length(checked) = 0 THEN
    RAISE EXCEPTION 'consent refused: nothing was checked, so nothing may post' USING ERRCODE = 'P0001';
  END IF;
  SELECT string_agg(x->>'address' || ' (' || (SELECT string_agg(DISTINCT r->>'refused_subject' || ' ' || (r->>'refused_how'), ', ') FROM jsonb_array_elements(x->'refused') r) || ')', '; ')
    INTO bad FROM jsonb_array_elements(coalesce(checked, '[]')) x WHERE (x->>'allowed')::boolean IS NOT TRUE;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'consent refused: someone shown or named here holds no grant for this use: %', bad USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('cleared', jsonb_array_length(coalesce(checked, '[]')));
END $function$;

CREATE OR REPLACE FUNCTION public.consent_model_answer(answer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a jsonb;
BEGIN
  IF answer IS NULL THEN RETURN NULL; END IF;
  BEGIN
    a := substring(answer from '(?s)\{.*\}')::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF a IS NULL OR jsonb_typeof(a) <> 'object' OR jsonb_typeof(a->'posts') IS DISTINCT FROM 'array' THEN
    RETURN NULL;
  END IF;
  RETURN a;
END $function$;

CREATE OR REPLACE FUNCTION public.consent_gate(checked jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $f$
BEGIN
  IF jsonb_typeof(checked) IS DISTINCT FROM 'array' OR jsonb_array_length(checked) = 0 THEN
    RAISE EXCEPTION 'consent refused: nothing was checked, so nothing may post' USING ERRCODE = 'P0001';
  END IF;
  RETURN consent_stop(checked);
END $f$;

CREATE OR REPLACE FUNCTION public.post_refusals(caption text, media text[], pu text, su text, suspects text[] DEFAULT '{}'::text[])
 RETURNS TABLE(refused_subject text, refused_how text, via text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY SELECT c.refused_subject, c.refused_how, c.via FROM consent_refusals(jsonb_build_object('caption', caption, 'media', to_jsonb(coalesce(media, '{}'::text[]))), pu, su, suspects) c;
END
$function$;

CREATE OR REPLACE FUNCTION public.material_prefix_check(m text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM material_prefix_rules r WHERE m ~ r.shape) THEN
    RAISE EXCEPTION 'material % has no known fence prefix; the fence reads only the prefixes in material_prefix_rules', m USING ERRCODE = 'check_violation';
  END IF;
  RETURN m;
END $function$;

CREATE OR REPLACE FUNCTION public.material_must_have_a_known_prefix()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM material_prefix_check(NEW.material);
  RETURN NEW;
END $function$;

CREATE TRIGGER tell_row_change AFTER INSERT OR DELETE OR UPDATE ON public.material_subjects FOR EACH ROW EXECUTE FUNCTION record_row_change()
CREATE TRIGGER material_subjects_known_prefix BEFORE INSERT OR UPDATE OF material ON public.material_subjects FOR EACH ROW EXECUTE FUNCTION material_must_have_a_known_prefix()

INSERT INTO public.material_prefix_rules (prefix, shape, why) VALUES
 ('clip/', '^clip/.+', 'a clip in Files, by its Files name or identity'),
 ('image/', '^image/.+', 'an image in Files, by its Files name or identity'),
 ('recording/', '^recording/1f:[0-9a-f]{64}$', 'a recording, by its content identity (the fence reads recording/1f:...)'),
 ('carousel_slide/', '^carousel_slide/.+', 'a slide of a carousel, by its folder and number')
ON CONFLICT (prefix) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS use_binding;

CREATE TABLE IF NOT EXISTS public.use_settings (
  name text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS use_binding.claims (
  nonce text PRIMARY KEY,
  xact xid8 NOT NULL UNIQUE,
  purpose text,
  surface text,
  claimed_by name NOT NULL,
  claimed_at timestamp with time zone NOT NULL DEFAULT now(),
  until timestamp with time zone NOT NULL
);

CREATE OR REPLACE FUNCTION use_binding.run_purpose()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'use_binding', 'pg_temp'
AS $function$ SELECT CASE WHEN c.nonce IS NOT NULL AND c.purpose IS NOT NULL THEN c.purpose ELSE (SELECT s.value FROM public.use_settings s WHERE s.name = 'purpose_when_unstated') END FROM (SELECT pg_current_xact_id_if_assigned() AS xact) t LEFT JOIN use_binding.claims c ON c.xact = t.xact $function$;

CREATE OR REPLACE FUNCTION use_binding.run_surface()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'use_binding', 'pg_temp'
AS $function$ SELECT coalesce(c.surface, '') FROM (SELECT pg_current_xact_id_if_assigned() AS xact) t LEFT JOIN use_binding.claims c ON c.xact = t.xact $function$;

CREATE OR REPLACE FUNCTION public.run_purpose()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$select use_binding.run_purpose()$function$;

CREATE OR REPLACE FUNCTION public.run_surface()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$select use_binding.run_surface()$function$;

CREATE TABLE IF NOT EXISTS public.person_aliases (
  alias text NOT NULL,
  person text NOT NULL,
  source text NOT NULL,
  added_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (alias, person)
);

INSERT INTO public.person_aliases (alias, person, source)
SELECT DISTINCT n.alias, z.subj, 'name or surname of the public-figure grant subject ' || z.subj
  FROM (SELECT g.subject AS subj, lower(btrim(substr(g.subject, length('public-figure:') + 1))) AS name FROM use_grants g WHERE g.subject LIKE 'public-figure:%') z,
       LATERAL (SELECT z.name AS alias WHERE length(z.name) >= 4
                UNION SELECT split_part(z.name, ' ', 2) WHERE z.name ~ '^[^ ]+ [^ ]+$' AND length(split_part(z.name, ' ', 2)) >= 4) n
ON CONFLICT (alias, person) DO NOTHING;

DO $seed$
BEGIN
  IF to_regclass('public.mentions') IS NOT NULL THEN
    INSERT INTO public.person_aliases (alias, person, source)
    SELECT DISTINCT n.alias, z.subj, 'name or surname of the public-figure person mention ' || z.subj
      FROM (SELECT DISTINCT m.value AS subj, lower(btrim(substr(m.value, length('public-figure:') + 1))) AS name FROM mentions m WHERE m.scheme = 'person' AND m.value LIKE 'public-figure:%') z,
           LATERAL (SELECT z.name AS alias WHERE length(z.name) >= 4
                    UNION SELECT split_part(z.name, ' ', 2) WHERE z.name ~ '^[^ ]+ [^ ]+$' AND length(split_part(z.name, ' ', 2)) >= 4) n
    ON CONFLICT (alias, person) DO NOTHING;
  END IF;
END
$seed$;

CREATE OR REPLACE FUNCTION public.quote_attributed(p_value jsonb, p_subject text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM jsonb_path_query(p_value, 'strict $.**') o
                  WHERE jsonb_typeof(o) = 'object' AND o ?| ARRAY['quote', 'text'] AND coalesce(o->>'quote', o->>'text', '') <> ''
                    AND lower(btrim(o->>'speaker')) = lower(btrim(substr(p_subject, length('public-figure:') + 1))))
  OR EXISTS (SELECT 1 FROM material_subjects ms
              WHERE ms.subject = p_subject AND ms.how = 'quoted'
                AND ms.material IN (SELECT x #>> '{}' FROM jsonb_path_query(p_value, 'strict $.**') x WHERE jsonb_typeof(x) = 'string'))
$function$;

CREATE OR REPLACE FUNCTION public.consent_refusals(p_value jsonb, p_purpose text, p_surface text, p_suspects text[] DEFAULT '{}'::text[])
 RETURNS TABLE(refused_subject text, refused_how text, via text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE all_text text;
BEGIN
  all_text := coalesce((SELECT string_agg(t, ' ') FROM (
    SELECT x #>> '{}' AS t FROM unnest(ARRAY['caption', 'title', 'alt', 'credit', 'text', 'headline', 'body']) k, jsonb_path_query(p_value, ('strict $.**.' || k)::jsonpath) x WHERE jsonb_typeof(x) = 'string'
    UNION ALL SELECT x #>> '{}' FROM jsonb_path_query(p_value, 'strict $.**.caption_by_platform.*') x WHERE jsonb_typeof(x) = 'string'
  ) audience), '');
  RETURN QUERY
  WITH named_m AS (
    SELECT DISTINCT x #>> '{}' AS m FROM jsonb_path_query(p_value, 'strict $.**') x
     WHERE jsonb_typeof(x) = 'string' AND EXISTS (SELECT 1 FROM material_prefix_rules r WHERE (x #>> '{}') ~ r.shape)
  ), subjects AS (
    SELECT s.subject, s.how, 'material ' || s.material AS via FROM material_subjects s WHERE s.material IN (SELECT m FROM named_m)
    UNION ALL
    SELECT 'unexamined'::text, 'unexamined'::text, 'no examined material'::text FROM named_m n WHERE NOT EXISTS (SELECT 1 FROM material_subjects s WHERE s.material = n.m)
  ), shown AS (
    SELECT DISTINCT sb.subject, sb.how, sb.via FROM subjects sb WHERE NOT pair_allowed(sb.subject, sb.how, p_purpose, p_surface)
  ), named AS (
    SELECT DISTINCT p.subject, 'named'::text, 'text ' || p.via FROM post_people(all_text) p WHERE NOT pair_allowed(p.subject, 'named', p_purpose, p_surface)
       AND NOT (pair_allowed(p.subject, 'quoted', p_purpose, p_surface) AND quote_attributed(p_value, p.subject))
    UNION
    SELECT DISTINCT a.person, 'named'::text, 'alias ' || a.alias FROM person_aliases a
     WHERE lower(all_text) ~ ('(^|[^a-z0-9_])' || regexp_replace(lower(a.alias), '([^a-z0-9 ])', E'\\\\\\1', 'g') || '([^a-z0-9_]|$)')
       AND NOT pair_allowed(a.person, 'named', p_purpose, p_surface)
       AND NOT (pair_allowed(a.person, 'quoted', p_purpose, p_surface) AND quote_attributed(p_value, a.person))
  ), people AS (
    SELECT DISTINCT lower(btrim(z.n)) AS nm FROM (
      SELECT x #>> '{}' AS n FROM jsonb_path_query(p_value, 'strict $.**.people[*]') x WHERE jsonb_typeof(x) = 'string'
      UNION ALL SELECT x->>'name' FROM jsonb_path_query(p_value, 'strict $.**.people[*]') x WHERE jsonb_typeof(x) = 'object'
      UNION ALL SELECT x #>> '{}' FROM jsonb_path_query(p_value, 'strict $.**.subjects[*]') x WHERE jsonb_typeof(x) = 'string'
    ) z WHERE btrim(coalesce(z.n, '')) <> ''
  ), structured AS (
    SELECT DISTINCT 'public-figure:' || pe.nm, 'appears'::text, 'structured people field'::text FROM people pe
     WHERE NOT owner_named(pe.nm) AND NOT pair_allowed('public-figure:' || pe.nm, 'appears', p_purpose, p_surface)
  ), guessed AS (
    SELECT DISTINCT 'suspect:' || lower(btrim(s)), 'named'::text, 'ai suspected, no row clears them'::text FROM unnest(coalesce(p_suspects, '{}')) s
     WHERE btrim(s) <> '' AND NOT pair_allowed('suspect:' || lower(btrim(s)), 'named', p_purpose, p_surface)
       AND NOT public_figure_cleared(s, p_purpose, p_surface, 'named')
       AND NOT owner_named(s)
       AND NOT EXISTS (SELECT 1 FROM post_people(s) q WHERE pair_allowed(q.subject, 'named', p_purpose, p_surface))
  )
  SELECT * FROM shown UNION SELECT * FROM named UNION SELECT * FROM structured UNION SELECT * FROM guessed;
END
$function$;

CREATE OR REPLACE FUNCTION public.post_refusals_for_value(p_value jsonb, p_purpose text, p_surface text)
 RETURNS TABLE(refused_subject text, refused_how text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY SELECT DISTINCT c.refused_subject, c.refused_how FROM consent_refusals(p_value, p_purpose, p_surface, '{}') c;
END
$function$;

CREATE OR REPLACE FUNCTION public.post_destination_text(p_dest jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN jsonb_typeof(p_dest) = 'object' THEN (p_dest->>'kind') || ':' || (p_dest->>'site') ELSE p_dest #>> '{}' END
$function$;

CREATE OR REPLACE FUNCTION public.post_destination_surface(p_value jsonb, p_dest jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN jsonb_typeof(p_dest) = 'object' THEN 'publish/site/article'
              ELSE coalesce(p_value->'surfaces'->>(p_dest #>> '{}'), 'social/' || (p_dest #>> '{}')) END
$function$;

CREATE OR REPLACE FUNCTION public.post_go_state_must_clear_consent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE x jsonb; d text; mats text[]; cap text; pu text; su text; n integer;
BEGIN
  IF NEW.status NOT IN ('scheduled', 'queued') THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.value->'destinations') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.value->'destinations') = 0 THEN
    RAISE EXCEPTION 'post % has no destination, so it may not be set to go', NEW.post_id USING ERRCODE = 'P0001';
  END IF;
  mats := ARRAY(SELECT m->>'material' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.value->'media') = 'array' THEN NEW.value->'media' ELSE '[]'::jsonb END) m);
  IF array_position(mats, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'post % has media with no material, so it may not be set to go', NEW.post_id USING ERRCODE = 'P0001';
  END IF;
  cap := coalesce(NEW.value->>'caption', '');
  pu := coalesce(nullif(NEW.value->>'purpose', ''), 'publish');
  FOR x IN SELECT jsonb_array_elements(NEW.value->'destinations') LOOP
    d := post_destination_text(x);
    su := post_destination_surface(NEW.value, x);
    SELECT count(*) INTO n FROM post_refusals_for_value(NEW.value, pu, su);
    IF n > 0 THEN
      RAISE EXCEPTION 'post % may not go to %: consent refused (% rows)', NEW.post_id, d, n USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END $function$;

DO $guard$
BEGIN
  IF to_regclass('public.post') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS post_go_state_consent ON public.post;
    CREATE TRIGGER post_go_state_consent BEFORE INSERT OR UPDATE OF status, value ON public.post FOR EACH ROW EXECUTE FUNCTION post_go_state_must_clear_consent();
  END IF;
END
$guard$;

-- The set-up workflow's own tables; a regenerated recipe keeps them.
CREATE TABLE IF NOT EXISTS setup_gaps (id text PRIMARY KEY, stage text NOT NULL, step text NOT NULL, undecided text NOT NULL, chosen text, status text NOT NULL DEFAULT 'open', kept_at timestamptz NOT NULL DEFAULT now(), evidence text, closed_by text);
CREATE TABLE IF NOT EXISTS setup_stages (stage text PRIMARY KEY, label text NOT NULL, status text NOT NULL, evidence text, grp text, kept_at timestamptz NOT NULL DEFAULT now(), steps_status jsonb, gaps text[]);
-- calendar_tasks, the pursuit task ledger, with its status list. Shape copied from the account's own store.
CREATE TABLE IF NOT EXISTS public.task_statuses (name text NOT NULL, mark text NOT NULL, tone text, counts_as_done boolean NOT NULL DEFAULT false, place integer NOT NULL, closed boolean NOT NULL DEFAULT false, CONSTRAINT task_statuses_pkey PRIMARY KEY (name));
INSERT INTO public.task_statuses (name, mark, tone, counts_as_done, place, closed) VALUES
  ('Done', 'done', NULL, true, 1, true),
  ('Redone by hand', 'done', '#d97706', false, 2, false),
  ('In progress', 'checking', '#2563eb', false, 3, false),
  ('Waiting', 'checking', '#a16207', false, 4, false),
  ('Blocked', 'unknown', '#dc2626', false, 5, false),
  ('Broken', 'unknown', '#dc2626', false, 6, false),
  ('To do', 'todo', NULL, false, 7, false),
  ('Not started', 'todo', NULL, false, 8, false),
  ('Not needed', 'todo', '#94a3b8', false, 9, true),
  ('Unknown', 'unknown', '#6b7280', false, 10, false),
  ('Landed, not live', 'landed', '#0891b2', false, 11, false)
ON CONFLICT (name) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.calendar_tasks (
  "id" text NOT NULL,
  "title" text,
  "parent_id" jsonb,
  "duplicate_of" text,
  "collection_id" jsonb,
  "description" text,
  "priority" text,
  "labels" jsonb,
  "duration_minutes" numeric,
  "minimum_duration_minutes" numeric,
  "slice_of" text,
  "deadline_type" text,
  "start_on" date,
  "blocked_by" jsonb,
  "pinned_until" date,
  "snoozed_until" date,
  "reminder_at" date,
  "reminder_delivered_at" date,
  "created_at" date,
  "time_spent_minutes" numeric,
  "placed_by" text,
  "due" date,
  "starts_at" date,
  "ends_at" date,
  "recurrence" text,
  "recurrence_series" text,
  "recurrence_index" numeric,
  "recurrence_rule_revision" numeric,
  "recurrence_anchor_date" date,
  "smart_list" text,
  "source_id" text,
  "source_url" text,
  "manual_order" text,
  "status" text,
  "children" jsonb,
  "assignee" text,
  "notes" text,
  "evidence" text,
  "job" text,
  "rules_judge_from" date,
  "handover" text,
  "progress_6_50pm" text,
  "progress_9_34pm" text,
  "check" text,
  "check_why" text,
  "list" jsonb,
  "pursuit" text,
  "parent" jsonb,
  "made_at" timestamptz DEFAULT now(),
  "changed_at" timestamptz DEFAULT now(),
  "plain_title" text,
  "plain_detail" text,
  "waiting_on" text,
  "assignees" jsonb,
  "taken_by" text,
  "taken_at" text,
  "sent_by" text,
  "sent_at" text,
  "outcome" text,
  "result" text,
  "summary" text,
  "finished_by" text,
  "finished_at" text,
  "details" jsonb,
  "moved_from" text,
  "check_spec" jsonb,
  CONSTRAINT calendar_tasks_pkey PRIMARY KEY (id),
  CONSTRAINT calendar_tasks_priority_check CHECK (priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text])),
  CONSTRAINT calendar_tasks_status_is_a_kept_status FOREIGN KEY (status) REFERENCES public.task_statuses(name) ON UPDATE CASCADE
);
-- Tables the content engine (keep-the-content-engine-writing) reads and writes, shape copied from the account's own store.
CREATE TABLE IF NOT EXISTS public.content_series (id text NOT NULL, name text NOT NULL, program_offer_ref text, cta_target text, kind text NOT NULL, CONSTRAINT content_series_pkey PRIMARY KEY (id));
CREATE TABLE IF NOT EXISTS public.series_episodes (series_id text NOT NULL, episode integer NOT NULL, source_ref text, article_id text, newsletter_section_id text, thread_post_id text, ig_post_ids jsonb NOT NULL DEFAULT '[]'::jsonb, video_identity jsonb, status text NOT NULL DEFAULT 'draft'::text, CONSTRAINT series_episodes_pkey PRIMARY KEY (series_id, episode), CONSTRAINT series_episodes_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.content_series(id));
CREATE TABLE IF NOT EXISTS public.article_drafts (id text NOT NULL, title text NOT NULL, body text NOT NULL, site text NOT NULL, status text NOT NULL DEFAULT 'draft'::text, made_from text[] NOT NULL DEFAULT '{}'::text[], kept_at timestamp with time zone NOT NULL DEFAULT now(), CONSTRAINT article_drafts_pkey PRIMARY KEY (id));
CREATE TABLE IF NOT EXISTS public.article_site_destinations (site text NOT NULL, connection text NOT NULL, publish_sql text NOT NULL, written_by text NOT NULL, kept_at timestamp with time zone NOT NULL DEFAULT now(), canonical_template text, CONSTRAINT article_site_destinations_pkey PRIMARY KEY (site));
CREATE TABLE IF NOT EXISTS public.post (post_id text NOT NULL, person text NOT NULL, status text NOT NULL, value jsonb NOT NULL, updated_at timestamp with time zone NOT NULL DEFAULT now(), CONSTRAINT post_pkey PRIMARY KEY (post_id));
CREATE TABLE IF NOT EXISTS public.seeds (id text NOT NULL, words text NOT NULL, came_from jsonb NOT NULL, media jsonb, at timestamp with time zone NOT NULL, kept_at timestamp with time zone NOT NULL DEFAULT now(), CONSTRAINT seeds_pkey PRIMARY KEY (id));
CREATE TABLE IF NOT EXISTS public.search_rules (id text NOT NULL, rule text NOT NULL, applies_to text NOT NULL, value jsonb NOT NULL, why text NOT NULL, decided_by text NOT NULL, decided_at timestamp with time zone NOT NULL DEFAULT now(), CONSTRAINT search_rules_pkey PRIMARY KEY (id));
CREATE TABLE IF NOT EXISTS public.voice_verdicts (id bigint NOT NULL, at timestamp with time zone NOT NULL DEFAULT now(), model text NOT NULL, workflow text, step text, kind_of_words text, words jsonb NOT NULL, line_scores jsonb NOT NULL, score double precision, held boolean NOT NULL, his_reaction text, reacted_at timestamp with time zone, channel text, tells_broken jsonb, new_claims jsonb, not_fluent jsonb, dropped_claims jsonb, laws_broken jsonb, CONSTRAINT voice_verdicts_pkey PRIMARY KEY (id));
CREATE TABLE IF NOT EXISTS public.content_engine_wakes (wake_id text NOT NULL, woke_at timestamp with time zone NOT NULL DEFAULT now(), picked jsonb NOT NULL DEFAULT '[]'::jsonb, skipped jsonb NOT NULL DEFAULT '[]'::jsonb, CONSTRAINT content_engine_wakes_pkey PRIMARY KEY (wake_id));
CREATE TABLE IF NOT EXISTS public.content_engine_item_outcomes (item_id text NOT NULL, wake_id text NOT NULL, outcome text NOT NULL, why text NOT NULL DEFAULT ''::text, at timestamp with time zone NOT NULL DEFAULT now(), CONSTRAINT content_engine_item_outcomes_pkey PRIMARY KEY (item_id));
CREATE TABLE IF NOT EXISTS public.wf_runs (run_id text NOT NULL, workflow text NOT NULL, lane text NOT NULL DEFAULT ''::text, request text NOT NULL DEFAULT ''::text, started_by text NOT NULL DEFAULT ''::text, started_at timestamp with time zone, computer text NOT NULL DEFAULT ''::text, status text NOT NULL, waiting jsonb NOT NULL DEFAULT '[]'::jsonb, failed jsonb NOT NULL DEFAULT '[]'::jsonb, updated_at timestamp with time zone NOT NULL DEFAULT now(), seed text NOT NULL DEFAULT ''::text, CONSTRAINT wf_runs_pkey PRIMARY KEY (run_id));

-- piece_reference_picks: the references a creative job was built from, keyed by the made file's identity (1f: + BLAKE3 hex).
-- Written by workflow:pick-references-from-the-inspiration-library when a making run passes its file identity.
CREATE TABLE IF NOT EXISTS public.piece_reference_picks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_identity text NOT NULL CHECK (file_identity ~ '^1f:[0-9a-f]{64}$'),
  reference_kind text NOT NULL,
  reference_id text NOT NULL,
  url text,
  why text NOT NULL,
  picked_at timestamptz NOT NULL DEFAULT now(),
  run text
);
CREATE INDEX IF NOT EXISTS piece_reference_picks_by_identity ON public.piece_reference_picks (file_identity);
