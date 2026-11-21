-- The consent fence for a pursuit's post table. The policy post.consent_fence reads the post's own value: every string in it
-- is a material, the fence takes the subjects of the materials that match a material_subjects row, and refuses an unknown
-- or unexamined one. Nothing here names a pursuit, database or login: the functions are created in the database the statement runs in.
-- Applied to one pursuit database on 2026-11-21, before 12:07 CST, by hand (no owner renders it yet; see the calendar task).
DO $apply$
BEGIN
CREATE OR REPLACE FUNCTION public.named_materials(value jsonb) RETURNS SETOF text LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  select x #>> '{}' from jsonb_path_query(value, 'strict $.**') x where jsonb_typeof(x) = 'string'
$function$;

CREATE OR REPLACE FUNCTION public.material_refusals_post(value jsonb, pu text, su text) RETURNS TABLE(refused_subject text, refused_how text) LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  with named as (select distinct m from named_materials(value) m),
  subjects as (
    select s.subject, s.how from material_subjects s where s.material in (select m from named)
    union all
    select 'unexamined', 'unexamined' where not exists (select 1 from material_subjects s where s.material in (select m from named))
  )
  select distinct sb.subject, sb.how from subjects sb where not pair_allowed(sb.subject, sb.how, pu, su)
$function$;

CREATE OR REPLACE FUNCTION public.material_allowed_post(value jsonb, pu text, su text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  select not exists (select 1 from material_refusals_post(value, pu, su))
$function$;

DROP POLICY consent_fence ON public.post;
CREATE POLICY consent_fence ON public.post AS PERMISSIVE FOR ALL TO public
  USING (material_allowed_post(value, run_purpose(), run_surface()))
  WITH CHECK (material_allowed_post(value, run_purpose(), run_surface()));
END
$apply$;
