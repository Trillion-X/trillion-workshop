-- Write-audit stack for one database: who wrote which row of each table handed to audit_writes_on, never the row's values.
-- No noticer or router reads write_audit, and no tell_row_change trigger may sit on it, so an audit line never becomes a fact.
CREATE TABLE IF NOT EXISTS write_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  table_name text NOT NULL,
  row_id jsonb,
  row_id_before jsonb,
  op text NOT NULL,
  login name NOT NULL DEFAULT session_user,
  application_name text DEFAULT current_setting('application_name', true),
  txid xid8 NOT NULL DEFAULT pg_current_xact_id());
CREATE INDEX IF NOT EXISTS write_audit_at ON write_audit (at);
REVOKE ALL ON write_audit FROM PUBLIC;

-- Row triggers pass the table's key columns as arguments: row_id is those columns only ({"id": "..."}), from the new row
-- (the old one for a delete); row_id_before is the old key when an update changed it. A trigger given no columns records
-- no row id (a table keyed by something personal). A truncate is one line with no row id. A failed audit line is a
-- warning and the write goes through, as record_row_change does.
CREATE OR REPLACE FUNCTION public.record_write_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE now_row jsonb; old_row jsonb; key jsonb; key_before jsonb;
BEGIN
  BEGIN
    IF TG_LEVEL = 'ROW' AND TG_NARGS > 0 THEN
      IF TG_OP <> 'DELETE' THEN now_row := to_jsonb(NEW); END IF;
      IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
      SELECT jsonb_object_agg(k, coalesce(now_row, old_row) -> k) INTO key FROM unnest(TG_ARGV) AS k;
      IF TG_OP = 'UPDATE' THEN
        SELECT jsonb_object_agg(k, old_row -> k) INTO key_before FROM unnest(TG_ARGV) AS k;
        IF key_before = key THEN key_before := NULL; END IF;
      END IF;
    END IF;
    INSERT INTO write_audit (table_name, row_id, row_id_before, op) VALUES (TG_TABLE_NAME, key, key_before, lower(TG_OP));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'record_write_audit: % (the % on % went through unaudited)', SQLERRM, TG_OP, TG_TABLE_NAME;
  END;
  RETURN NULL;
END $function$
;
REVOKE ALL ON FUNCTION public.record_write_audit() FROM PUBLIC;

-- Puts the audit triggers on one table: its primary-key columns become the row trigger's arguments, or none when
-- with_row_id is false. Refuses write_audit and row_changes themselves. Run again, it puts the same triggers back.
CREATE OR REPLACE FUNCTION public.audit_writes_on(audited regclass, with_row_id boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE keys text := '';
BEGIN
  IF audited = 'public.write_audit'::regclass OR audited = to_regclass('public.row_changes') THEN
    RAISE EXCEPTION 'audit_writes_on: % is never audited (its lines would audit themselves or become facts)', audited;
  END IF;
  IF with_row_id THEN
    SELECT string_agg(quote_literal(a.attname), ', ' ORDER BY k.n) INTO keys
      FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = audited AND i.indisprimary;
    IF keys IS NULL THEN
      RAISE EXCEPTION 'audit_writes_on: % has no primary key; name it with with_row_id false to audit it without row ids', audited;
    END IF;
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS audit_write ON %s', audited);
  EXECUTE format('CREATE TRIGGER audit_write AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION record_write_audit(%s)', audited, keys);
  EXECUTE format('DROP TRIGGER IF EXISTS audit_truncate ON %s', audited);
  EXECUTE format('CREATE TRIGGER audit_truncate AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION record_write_audit()', audited);
  RETURN audited::text;
END $function$
;
REVOKE ALL ON FUNCTION public.audit_writes_on(regclass, boolean) FROM PUBLIC;

-- Keeps the last keep_days of audit lines; the retention wake runs it once a day.
CREATE OR REPLACE FUNCTION public.forget_old_write_audit(keep_days integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE gone bigint;
BEGIN
  IF keep_days IS NULL OR keep_days < 1 THEN
    RAISE EXCEPTION 'forget_old_write_audit: keep_days is a whole number of days, at least 1 (given %)', keep_days;
  END IF;
  DELETE FROM write_audit WHERE at < clock_timestamp() - make_interval(days => keep_days);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $function$
;
REVOKE ALL ON FUNCTION public.forget_old_write_audit(integer) FROM PUBLIC;
