-- The one rule every outlet asks before a file reaches a person or the public: a piece may go out only when the latest gate
-- decision for its content identity (1f: plus 64 lowercase hex BLAKE3) in THIS pursuit's store is passed. A file no run
-- made, a file that failed review, and a file that passed in another pursuit's store all have no passed decision here, so
-- all are refused. The reason says which rule refused it. Parameters: file_identity. Safe to run again.
CREATE OR REPLACE FUNCTION public.piece_may_go_out(file_identity text)
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d record;
BEGIN
  IF file_identity IS NULL OR file_identity !~ '^1f:[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT false, 'not a content identity (1f: plus 64 lowercase hex BLAKE3)'::text;
    RETURN;
  END IF;
  SELECT g.passed, g.run INTO d
    FROM public.piece_gate_decisions g
   WHERE g.file_identity = piece_may_go_out.file_identity
   ORDER BY g.at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no gate decision for this file in this pursuit';
    RETURN;
  END IF;
  IF NOT d.passed THEN
    RETURN QUERY SELECT false, 'latest gate decision failed (run ' || coalesce(d.run, '') || ')';
    RETURN;
  END IF;
  RETURN QUERY SELECT true, 'passed review (run ' || coalesce(d.run, '') || ')';
END
$function$;
