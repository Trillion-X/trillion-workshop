-- Email-course rows for one database: where a pursuit keeps the rows the send-messages course tools work over (records in,
-- keep out). One table of { id, type, value } rows, a table of courses by id, and keep_email_course_rows, which writes a
-- tool's keep all or nothing: each row is written only if the stored row is still the one the tool was handed (expected),
-- else nothing of the keep is written. No noticer or router reads these tables.
CREATE TABLE IF NOT EXISTS email_course_records (
  id text PRIMARY KEY,
  type text NOT NULL,
  value jsonb NOT NULL,
  kept_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX IF NOT EXISTS email_course_records_type ON email_course_records (type);
CREATE TABLE IF NOT EXISTS email_courses (
  id text PRIMARY KEY,
  course jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON email_course_records, email_courses FROM PUBLIC;

-- keep is the tool's keep: [{ id, type, value, expected }], value null removes the row, expected is the row as it was handed
-- in ({ type, value }) or null when it was absent. Answers how many rows were written.
CREATE OR REPLACE FUNCTION public.keep_email_course_rows(keep jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb; kept integer := 0; touched integer;
BEGIN
  IF jsonb_typeof(keep) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'keep_email_course_rows: keep is a list of rows';
  END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(keep) x LOOP
    IF jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'type') IS DISTINCT FROM 'string' OR NOT (r ? 'value') OR NOT (r ? 'expected') THEN
      RAISE EXCEPTION 'keep_email_course_rows: each row is { id, type, value, expected }';
    END IF;
    IF jsonb_typeof(r->'expected') = 'null' THEN
      IF jsonb_typeof(r->'value') = 'null' THEN
        PERFORM 1 FROM email_course_records WHERE id = r->>'id';
        touched := CASE WHEN FOUND THEN 0 ELSE 1 END;
      ELSE
        INSERT INTO email_course_records (id, type, value) VALUES (r->>'id', r->>'type', r->'value') ON CONFLICT (id) DO NOTHING;
        GET DIAGNOSTICS touched = ROW_COUNT;
      END IF;
    ELSIF jsonb_typeof(r->'value') = 'null' THEN
      DELETE FROM email_course_records WHERE id = r->>'id' AND type = r->'expected'->>'type' AND value = r->'expected'->'value';
      GET DIAGNOSTICS touched = ROW_COUNT;
    ELSE
      UPDATE email_course_records SET type = r->>'type', value = r->'value', kept_at = clock_timestamp()
       WHERE id = r->>'id' AND type = r->'expected'->>'type' AND value = r->'expected'->'value';
      GET DIAGNOSTICS touched = ROW_COUNT;
    END IF;
    IF touched <> 1 THEN
      RAISE EXCEPTION 'keep_email_course_rows: row % changed since it was read, so nothing of this keep is written', r->>'id' USING ERRCODE = '40001';
    END IF;
    kept := kept + 1;
  END LOOP;
  RETURN kept;
END $function$
;
REVOKE ALL ON FUNCTION public.keep_email_course_rows(jsonb) FROM PUBLIC;
