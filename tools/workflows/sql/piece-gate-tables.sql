-- Piece gate for one pursuit database: the verdicts a check writes, the checks each kind of piece must pass, and each gate
-- decision wf writes. piece_gate_misses returns why a piece of a kind is refused (no rows = it passes); piece_gate_passes is
-- true when it returns none. A missing verdict is a miss, a failed verdict is a miss, a verdict by one of the piece's makers
-- is a miss, and a kind with no required checks is a miss. Read by every gate and by the publish trigger.
-- Parameters: none. Safe to run again.
CREATE TABLE IF NOT EXISTS public.piece_check_verdicts (
  piece text,
  file_identity text NOT NULL,
  check_id text NOT NULL,
  passed boolean NOT NULL,
  reviewer text,
  maker text,
  reason text,
  evidence jsonb,
  run text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_identity, check_id, at)
);

CREATE TABLE IF NOT EXISTS public.piece_required_checks (
  kind text NOT NULL,
  check_id text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  threshold jsonb,
  since timestamptz,
  PRIMARY KEY (kind, check_id)
);

CREATE TABLE IF NOT EXISTS public.piece_gate_decisions (
  run text NOT NULL,
  piece text,
  file_identity text NOT NULL,
  kind text NOT NULL,
  passed boolean NOT NULL,
  misses jsonb,
  maker text,
  reviewer text,
  round integer NOT NULL DEFAULT 1,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run, file_identity, kind, at)
);

-- A piece is the stable id of the thing across its versions (a series episode id); a file is one version of it.
ALTER TABLE public.piece_check_verdicts ADD COLUMN IF NOT EXISTS piece text;
ALTER TABLE public.piece_gate_decisions ADD COLUMN IF NOT EXISTS piece text;

CREATE OR REPLACE FUNCTION public.piece_gate_misses(file_identity text, kind text, makers text[])
RETURNS TABLE (check_id text, reason text, named jsonb)
LANGUAGE sql STABLE AS $$
  WITH required AS (
    SELECT r.check_id FROM public.piece_required_checks r
    WHERE r.kind = piece_gate_misses.kind AND r.required AND (r.since IS NULL OR r.since <= now())
  ),
  latest AS (
    SELECT DISTINCT ON (v.check_id) v.check_id, v.passed, v.reviewer, v.reason
    FROM public.piece_check_verdicts v
    WHERE v.file_identity = piece_gate_misses.file_identity
      AND v.check_id IN (SELECT check_id FROM required)
    ORDER BY v.check_id, v.at DESC
  )
  SELECT 'kind:' || piece_gate_misses.kind, 'no required checks for this kind', '{}'::jsonb
  WHERE NOT EXISTS (SELECT 1 FROM required)
  UNION ALL
  SELECT r.check_id, 'no verdict for this file', jsonb_build_object('file_identity', piece_gate_misses.file_identity)
  FROM required r
  WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.check_id = r.check_id)
  UNION ALL
  SELECT l.check_id, 'latest verdict failed: ' || coalesce(l.reason, ''), jsonb_build_object('reason', l.reason)
  FROM latest l WHERE NOT l.passed
  UNION ALL
  SELECT l.check_id, 'verdict reviewer is a maker of this piece', jsonb_build_object('reviewer', l.reviewer)
  FROM latest l WHERE l.reviewer = ANY (coalesce(piece_gate_misses.makers, '{}'::text[]))
$$;

CREATE OR REPLACE FUNCTION public.piece_gate_passes(file_identity text, kind text, makers text[])
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.piece_gate_misses(piece_gate_passes.file_identity, piece_gate_passes.kind, piece_gate_passes.makers))
$$;
