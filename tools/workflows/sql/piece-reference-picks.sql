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
