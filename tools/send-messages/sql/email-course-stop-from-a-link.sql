-- A stop link's two owner functions, for a site whose own key answers the link (an action row: read, tool:stop-an-email-course,
-- keep), so the site's logins hold no read or write of email_course_records itself. Made by the database's owner (SET ROLE to it
-- first, so each SECURITY DEFINER function belongs to the owner and never to a superuser), after sql/email-course-rows.sql.
--
-- email_course_stop_records(token): the records tool:stop-an-email-course needs for one token, and nothing else: the subscription
-- whose unsubscribe_token it is, that subscription's token row, and the stop rows of its contact; [] for a token no subscription
-- holds. It reads no contact-point row, so no address reaches the caller. Granted to the site's reader login.
CREATE OR REPLACE FUNCTION public.email_course_stop_records(token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH sub AS (SELECT id, type, value FROM email_course_records WHERE type = 'email-course-subscription' AND value->>'unsubscribe_token' = $1),
tok AS (SELECT r.id, r.type, r.value FROM email_course_records r JOIN sub ON r.value->>'subscription_address' = sub.id WHERE r.type = 'email-course-token'),
stp AS (SELECT r.id, r.type, r.value FROM email_course_records r JOIN sub ON r.value->>'account_id' = sub.value->>'account_id' WHERE r.type = 'email-course-stop')
SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'type', x.type, 'value', x.value) ORDER BY x.id), '[]'::jsonb)
FROM (SELECT * FROM sub UNION ALL SELECT * FROM tok UNION ALL SELECT * FROM stp) x
$function$;
REVOKE ALL ON FUNCTION public.email_course_stop_records(text) FROM PUBLIC;

-- keep_an_email_course_stop(keep): a stop's keep written by keep_email_course_rows (each row only while it is still the row the
-- tool was handed, all or nothing), refused whole when any row it writes or expects is not a subscription, token or stop row,
-- so the login that holds it can change no lesson, contact point or course. Granted to the site's writer login.
CREATE OR REPLACE FUNCTION public.keep_an_email_course_stop(keep jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF jsonb_typeof(keep) IS DISTINCT FROM 'array' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(keep) r
    WHERE coalesce(r->>'type', '') NOT IN ('email-course-subscription', 'email-course-token', 'email-course-stop')
       OR (jsonb_typeof(r->'expected') = 'object' AND coalesce(r->'expected'->>'type', '') NOT IN ('email-course-subscription', 'email-course-token', 'email-course-stop'))) THEN
    RAISE EXCEPTION 'A stop keeps only subscription, token and stop rows.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.keep_email_course_rows(keep);
END $function$;
REVOKE ALL ON FUNCTION public.keep_an_email_course_stop(jsonb) FROM PUBLIC;
