-- The history of anything, under any of its identifiers: one rendering, for a Postgres store.
-- It names no domain, no source, no vendor and no person. What a thing, an identifier, a source and a meaning are
-- is configuration: rows of schemes, meanings, meaning_rules, mention_rules and tell_words.
--
-- Invariants:
--   1. Nothing is overwritten. A statement is kept as told; a wrong one is retracted by a later statement.
--   2. A telling delivered twice is one row: (source, told) is unique.
--   3. A thing is the identifier its links end at. A link is a statement whose meaning row names the role it joins
--      from and the role it joins to; links are directed, so a shared identifier shows on each thing it reaches and
--      never joins those things. Merge is one link statement; split is one retraction.
--   4. A link holds over [holds_from, holds_until); a statement reaches a thing only through links holding at the
--      statement's `at`. An identifier given to someone else later (a recycled number) keeps its old history.
--   5. Every read takes `known`: what was recorded by then. Late and out-of-order statements sort by `at`.
--   6. What is due to be told about a thing is a read: the standing statements of a meaning with tell_after, newer
--      than the thing's last tell, once the newest is older than the longest tell_after among them; one tells row per
--      thing and statement keeps a tell from being made twice. Which meanings are told, how long they settle, which
--      kinds of thing are told about and the words for a set of meanings are rows.
--   7. Erasure empties every statement in the thing's history and deletes their mentions; (source, told) stays, so a
--      redelivery of an erased telling stays erased.

CREATE TABLE statements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,                       -- who told it
  told text NOT NULL,                         -- the teller's own id for this telling
  place text, change text,                    -- where in the teller it changed, and how, in the teller's words
  at timestamptz NOT NULL,                    -- when it happened, as told
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  key text,                                   -- the item's own key in the teller's words
  before jsonb, after jsonb, detail jsonb,
  meaning text,                               -- given by the teller, else filled from meaning_rules
  retracts bigint REFERENCES statements (id),
  holds_from timestamptz, holds_until timestamptz,
  erased_at timestamptz,
  UNIQUE (source, told),
  CHECK (holds_from IS NULL OR holds_until IS NULL OR holds_from < holds_until));
CREATE INDEX statements_retracts ON statements (retracts) WHERE retracts IS NOT NULL;

CREATE TABLE mentions (
  statement bigint NOT NULL REFERENCES statements (id) ON DELETE CASCADE,
  role text NOT NULL, scheme text NOT NULL, value text NOT NULL,
  PRIMARY KEY (statement, role, scheme, value));
CREATE INDEX mentions_identifier ON mentions (scheme, value);

-- Configuration. Every row is optional: a scheme, source or meaning with no row still works.
CREATE TABLE schemes (scheme text PRIMARY KEY, fold_case boolean NOT NULL DEFAULT false, most_things int, words text,
  told_about boolean NOT NULL DEFAULT false);  -- due_tells speaks of things of this scheme
CREATE TABLE meanings (meaning text PRIMARY KEY, joins_from text, joins_to text, words text, tell_after interval,
  CHECK ((joins_from IS NULL) = (joins_to IS NULL)));
CREATE TABLE meaning_rules (position int PRIMARY KEY, source text, place text, change text, path text, meaning text NOT NULL);
CREATE TABLE tell_words (position int PRIMARY KEY, all_of text[] NOT NULL, words text NOT NULL);
CREATE TABLE tells (thing_scheme text NOT NULL, thing_value text NOT NULL, through bigint NOT NULL REFERENCES statements (id),
  words text NOT NULL, made_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (thing_scheme, thing_value, through));
CREATE TABLE mention_rules (source text, place text, path text NOT NULL, role text NOT NULL, scheme text NOT NULL,
  UNIQUE NULLS NOT DISTINCT (source, place, path, role, scheme));
-- The told change as one document, for rule paths: $.key, $.place, $.change, $.before, $.after, $.detail.
CREATE FUNCTION told_document(s statements) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('key', s.key, 'place', s.place, 'change', s.change, 'before', s.before, 'after', s.after, 'detail', s.detail) $$;

CREATE FUNCTION fill_meaning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meaning IS NULL THEN
    NEW.meaning := coalesce((SELECT r.meaning FROM meaning_rules r
      WHERE (r.source IS NULL OR r.source = NEW.source) AND (r.place IS NULL OR r.place = NEW.place)
        AND (r.change IS NULL OR r.change = NEW.change) AND (r.path IS NULL OR jsonb_path_exists(told_document(NEW), r.path::jsonpath))
      ORDER BY r.position LIMIT 1), 'unknown');
  END IF;
  IF NEW.retracts IS NOT NULL AND EXISTS (SELECT 1 FROM statements x WHERE x.id = NEW.retracts AND x.retracts IS NOT NULL) THEN
    RAISE EXCEPTION 'Statement % is itself a retraction. To undo it, tell the retracted statement again.', NEW.retracts;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fill_meaning BEFORE INSERT ON statements FOR EACH ROW EXECUTE FUNCTION fill_meaning();

CREATE FUNCTION mention_what_rules_find() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mentions (statement, role, scheme, value)
  SELECT NEW.id, r.role, r.scheme, v #>> '{}'
  FROM mention_rules r CROSS JOIN LATERAL jsonb_path_query(told_document(NEW), r.path::jsonpath) v
  WHERE (r.source IS NULL OR r.source = NEW.source) AND (r.place IS NULL OR r.place = NEW.place)
    AND jsonb_typeof(v) IN ('string', 'number')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER mention_what_rules_find AFTER INSERT ON statements FOR EACH ROW EXECUTE FUNCTION mention_what_rules_find();

CREATE FUNCTION fold_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT fold_case FROM schemes WHERE scheme = NEW.scheme) THEN NEW.value := lower(NEW.value); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fold_case BEFORE INSERT ON mentions FOR EACH ROW EXECUTE FUNCTION fold_case();

-- Whether statement `id` stands, as known at `known`.
CREATE FUNCTION stands(id bigint, known timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM statements x WHERE x.retracts = stands.id AND x.recorded_at <= stands.known) $$;

-- Every identifier that reaches (scheme, value), with the span its path holds over.
CREATE FUNCTION known_as(scheme text, value text, known timestamptz DEFAULT 'infinity')
RETURNS TABLE (scheme text, value text, lo timestamptz, hi timestamptz) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE reach (scheme, value, lo, hi) AS (
    SELECT known_as.scheme, known_as.value, '-infinity'::timestamptz, 'infinity'::timestamptz
    UNION
    SELECT f.scheme, f.value, greatest(r.lo, coalesce(s.holds_from, '-infinity')), least(r.hi, coalesce(s.holds_until, 'infinity'))
    FROM reach r
    JOIN mentions t ON t.scheme = r.scheme AND t.value = r.value
    JOIN statements s ON s.id = t.statement AND s.recorded_at <= known AND s.retracts IS NULL AND s.erased_at IS NULL
    JOIN meanings m ON m.meaning = s.meaning AND m.joins_to = t.role
    JOIN mentions f ON f.statement = s.id AND f.role = m.joins_from
    WHERE stands(s.id, known)
      AND greatest(r.lo, coalesce(s.holds_from, '-infinity')) < least(r.hi, coalesce(s.holds_until, 'infinity')))
  SELECT * FROM reach $$;

-- Every identifier (scheme, value) reaches through links holding at `at`, itself included.
CREATE FUNCTION reaches(scheme text, value text, at_time timestamptz, known timestamptz DEFAULT 'infinity')
RETURNS TABLE (scheme text, value text) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE reach (scheme, value) AS (
    SELECT reaches.scheme, reaches.value
    UNION
    SELECT t.scheme, t.value
    FROM reach r
    JOIN mentions f ON f.scheme = r.scheme AND f.value = r.value
    JOIN statements s ON s.id = f.statement AND s.recorded_at <= known AND s.retracts IS NULL AND s.erased_at IS NULL
      AND coalesce(s.holds_from, '-infinity') <= at_time AND at_time < coalesce(s.holds_until, 'infinity')
    JOIN meanings m ON m.meaning = s.meaning AND m.joins_from = f.role
    JOIN mentions t ON t.statement = s.id AND t.role = m.joins_to
    WHERE stands(s.id, known))
  SELECT * FROM reach $$;

-- The things (scheme, value) is an identifier of at `at`: the ends its links lead to. A loop of links with no way out
-- is one thing, named by its least identifier.
CREATE FUNCTION things_of(scheme text, value text, at_time timestamptz DEFAULT now(), known timestamptz DEFAULT 'infinity')
RETURNS TABLE (scheme text, value text) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT n.scheme, n.value
  FROM reaches(things_of.scheme, things_of.value, at_time, known) x
  CROSS JOIN LATERAL (SELECT y.scheme, y.value FROM reaches(x.scheme, x.value, at_time, known) y ORDER BY 1, 2 LIMIT 1) n
  WHERE NOT EXISTS (SELECT 1 FROM reaches(x.scheme, x.value, at_time, known) y
    WHERE NOT EXISTS (SELECT 1 FROM reaches(y.scheme, y.value, at_time, known) z WHERE z.scheme = x.scheme AND z.value = x.value)) $$;

-- The history of a thing: every statement about any identifier that reached it when the statement happened, every
-- retraction of one, oldest first. `shared` says a mentioned identifier is also another thing's.
CREATE FUNCTION history(scheme text, value text, known timestamptz DEFAULT 'infinity')
RETURNS TABLE (id bigint, at timestamptz, recorded_at timestamptz, source text, meaning text, words text, stands boolean,
  retracts bigint, said_as text, shared boolean, after jsonb, detail jsonb) LANGUAGE sql STABLE AS $$
  WITH reach AS (SELECT * FROM known_as(history.scheme, history.value, known)),
  shown AS (
    SELECT DISTINCT ON (s.id) s.*, m.scheme || ' ' || m.value AS said_as, m.scheme AS m_scheme, m.value AS m_value
    FROM reach r JOIN mentions m ON m.scheme = r.scheme AND m.value = r.value
    JOIN statements s ON s.id = m.statement AND s.recorded_at <= known AND s.at >= r.lo AND s.at < r.hi
    ORDER BY s.id, m.scheme, m.value),
  plus AS (
    SELECT * FROM shown
    UNION ALL
    SELECT s.*, NULL, NULL, NULL FROM statements s
    WHERE s.retracts IN (SELECT id FROM shown) AND s.recorded_at <= known AND s.id NOT IN (SELECT id FROM shown))
  SELECT p.id, p.at, p.recorded_at, p.source, p.meaning, mn.words, stands(p.id, known), p.retracts, p.said_as,
    p.m_scheme IS NOT NULL AND (SELECT count(*) FROM things_of(p.m_scheme, p.m_value, p.at, known)) > 1,
    p.after, p.detail
  FROM plus p LEFT JOIN meanings mn ON mn.meaning = p.meaning
  ORDER BY p.at, p.recorded_at, p.id $$;

-- Identifiers that reach more things than their scheme allows (most_things). Reported, never broken by itself.
CREATE FUNCTION too_shared(at_time timestamptz DEFAULT now()) RETURNS TABLE (scheme text, value text, things bigint) LANGUAGE sql STABLE AS $$
  SELECT i.scheme, i.value, count(*) FROM (SELECT DISTINCT m.scheme, m.value FROM mentions m JOIN schemes sc ON sc.scheme = m.scheme AND sc.most_things IS NOT NULL) i
  CROSS JOIN LATERAL things_of(i.scheme, i.value, at_time) t
  GROUP BY i.scheme, i.value HAVING count(*) > (SELECT most_things FROM schemes WHERE scheme = i.scheme) $$;

-- What is due to be told, per thing: statements of a meaning with tell_after, standing, not covered by an earlier
-- tell of that thing, once the newest of them is older than the longest tell_after among them.
CREATE FUNCTION due_tells(now_at timestamptz DEFAULT now())
RETURNS TABLE (thing_scheme text, thing_value text, through bigint, meanings text[], words text) LANGUAGE sql STABLE AS $$
  WITH fresh AS (
    SELECT DISTINCT s.id, s.meaning, s.recorded_at, mn.tell_after, th.scheme AS ts, th.value AS tv
    FROM statements s JOIN meanings mn ON mn.meaning = s.meaning AND mn.tell_after IS NOT NULL
    JOIN mentions m ON m.statement = s.id
    CROSS JOIN LATERAL things_of(m.scheme, m.value, s.at) th
    JOIN schemes sc ON sc.scheme = th.scheme AND sc.told_about
    WHERE s.retracts IS NULL AND s.erased_at IS NULL AND stands(s.id, now_at) AND s.recorded_at <= now_at
      AND s.id > coalesce((SELECT max(t.through) FROM tells t WHERE t.thing_scheme = th.scheme AND t.thing_value = th.value), 0)),
  batch AS (
    SELECT ts, tv, max(id) AS through, array_agg(DISTINCT meaning ORDER BY meaning) AS meanings,
      max(recorded_at) AS newest, max(tell_after) AS wait
    FROM fresh GROUP BY ts, tv)
  SELECT b.ts, b.tv, b.through, b.meanings,
    coalesce((SELECT w.words FROM tell_words w WHERE w.all_of <@ b.meanings ORDER BY w.position LIMIT 1),
      (SELECT string_agg(coalesce(mn.words, mn.meaning), ', ' ORDER BY mn.meaning) FROM meanings mn WHERE mn.meaning = ANY (b.meanings)))
  FROM batch b WHERE now_at - b.newest >= b.wait $$;


-- Erase a thing: empty every statement that mentions an identifier which, when the statement happened, was this
-- thing's alone, and every retraction of one; delete their mentions. A statement about an identifier another thing
-- shares stays for that thing, and the erased thing's own link to it goes with the rest. Returns how many were emptied.
CREATE FUNCTION erase(scheme text, value text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE emptied bigint;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS to_erase (id bigint PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO to_erase
  SELECT DISTINCT s.id FROM known_as(erase.scheme, erase.value) r
  JOIN mentions m ON m.scheme = r.scheme AND m.value = r.value
  JOIN statements s ON s.id = m.statement AND s.at >= r.lo AND s.at < r.hi
  WHERE NOT EXISTS (SELECT 1 FROM things_of(m.scheme, m.value, s.at) th WHERE th.scheme <> erase.scheme OR th.value <> erase.value)
  ON CONFLICT DO NOTHING;
  INSERT INTO to_erase SELECT s.id FROM statements s JOIN to_erase e ON s.retracts = e.id ON CONFLICT DO NOTHING;
  UPDATE statements s SET before = NULL, after = NULL, detail = NULL, key = NULL, erased_at = clock_timestamp()
    FROM to_erase e WHERE s.id = e.id;
  GET DIAGNOSTICS emptied = ROW_COUNT;
  DELETE FROM mentions m USING to_erase e WHERE m.statement = e.id;
  DELETE FROM to_erase;
  RETURN emptied;
END $$;
