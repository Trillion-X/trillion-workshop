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
                   and covers(g.purpose, pu) and covers(g.surface, su)
                   and g.given_at <= now() and (g.withdrawn_at is null or g.withdrawn_at > now())
                   and (g.holds_until is null or g.holds_until > now()))
  and not exists (select 1 from use_grants g where g.effect = 'deny' and covers(g.subject, s) and covers(g.how, h)
                   and covers(g.purpose, pu) and covers(g.surface, su)
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

CREATE OR REPLACE FUNCTION public.public_figure_cleared(who text, pu text, su text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH n AS (SELECT replace(replace(lower(btrim(who)), '%', ''), '_', '') AS v),
  live AS (SELECT g.* FROM use_grants g, n
            WHERE n.v <> '' AND length(n.v) >= 4
              AND (g.subject = 'public-figure:' || n.v OR g.subject LIKE 'public-figure:% ' || n.v)
              AND covers(g.how, 'quoted') AND covers(g.purpose, pu) AND covers(g.surface, su)
              AND g.given_at <= now() AND (g.withdrawn_at IS NULL OR g.withdrawn_at > now())
              AND (g.holds_until IS NULL OR g.holds_until > now()))
  SELECT EXISTS (SELECT 1 FROM live WHERE effect = 'allow' AND evidence ~ '^https?://')
     AND NOT EXISTS (SELECT 1 FROM live WHERE effect = 'deny')
$function$;

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
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH shown AS (
    SELECT DISTINCT mr.refused_subject, mr.refused_how, 'media ' || m AS via
      FROM unnest(coalesce(media, '{}')) m, LATERAL material_refusals(m, NULL, NULL, pu, su) mr
  ), named AS (
    SELECT DISTINCT p.subject, 'named'::text AS how, 'text ' || p.via AS via FROM post_people(caption) p
     WHERE NOT pair_allowed(p.subject, 'named', pu, su)
  ), guessed AS (
    SELECT DISTINCT 'suspect:' || lower(btrim(s)) AS subject, 'named'::text AS how, 'ai suspected, no row clears them' AS via
      FROM unnest(coalesce(suspects, '{}')) s
     WHERE btrim(s) <> '' AND NOT pair_allowed('suspect:' || lower(btrim(s)), 'named', pu, su)
       AND NOT public_figure_cleared(s, pu, su)
       AND NOT owner_named(s)
       AND NOT EXISTS (SELECT 1 FROM post_people(s) q WHERE pair_allowed(q.subject, 'named', pu, su))
  )
  SELECT * FROM shown UNION SELECT * FROM named UNION SELECT * FROM guessed;
END $function$;

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

CREATE OR REPLACE FUNCTION public.post_refusals_for_value(p_value jsonb, p_purpose text, p_surface text)
 RETURNS TABLE(refused_subject text, refused_how text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH named AS (
    SELECT DISTINCT x #>> '{}' AS m FROM jsonb_path_query(p_value, 'strict $.**') x WHERE jsonb_typeof(x) = 'string'
  ),
  subjects AS (
    SELECT s.subject, s.how FROM material_subjects s WHERE s.material IN (SELECT m FROM named)
    UNION ALL
    SELECT 'unexamined', 'unexamined' WHERE NOT EXISTS (SELECT 1 FROM material_subjects s WHERE s.material IN (SELECT m FROM named))
  )
  SELECT DISTINCT sb.subject, sb.how FROM subjects sb WHERE NOT pair_allowed(sb.subject, sb.how, p_purpose, p_surface)
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
    SELECT count(*) INTO n FROM post_refusals(cap, mats, pu, su, '{}');
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
