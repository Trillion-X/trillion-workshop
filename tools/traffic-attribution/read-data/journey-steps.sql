-- tools/traffic-attribution/read-data/journey-steps.sql
--
-- The journey kit's tables and views, for a pursuit's _for_who_runs_it database. Run it as often as you like: every
-- statement is idempotent. Step kinds, joins and limits are DATA in read-data/journey.json; the step names the views
-- count ('click', 'visit', 'lead', 'booking', 'checkout', 'sale') are the same words that file names.

-- Safe on a live pursuit database with rows in it. Every statement creates only what is missing (IF NOT EXISTS) and never drops,
-- truncates or rewrites a row. The views hold no rows: they are dropped and created again on each apply, because a column added
-- to journey_steps lands inside the views' column lists, which CREATE OR REPLACE VIEW cannot move; the keep tool restores each
-- view's grants after the file runs (its applySchema). A column added later is
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS. The keep tool applies this file once per version (the version is a BLAKE3 of these
-- bytes, kept in journey_kit_schema), so a change here reaches every pursuit within one run.

-- Which version of this file a database has applied (written by the keep tool, which hashes these bytes).
CREATE TABLE IF NOT EXISTS journey_kit_schema (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- One row per tracked link made for a post, ad, email or bio: the destination it opens and the source it carries.
CREATE TABLE IF NOT EXISTS journey_touches (
  id          text PRIMARY KEY,
  destination text NOT NULL,
  source      jsonb NOT NULL,
  post_id     text,
  offer_id    text,
  made_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per step a visitor or a person takes. A step with a ref (a booking key, a checkout or payment id) is kept
-- once: writing it again is a no-op, so a retried webhook or a reloaded thank-you page adds nothing.
CREATE TABLE IF NOT EXISTS journey_steps (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  visitor     text,
  touch_id    text,
  step        text NOT NULL,
  source      jsonb,
  ref         text,
  joined_by   text,
  email_key   text,
  offer_id    text,
  value_cents bigint
);

-- A step a proof made (read-data/journey.json proof): kept so the proof can read it back, counted by no view, and purged by the
-- keep tool once it is old (purgeProofRows).
ALTER TABLE journey_steps ADD COLUMN IF NOT EXISTS is_proof boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS journey_steps_step_ref ON journey_steps (step, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS journey_steps_visitor ON journey_steps (visitor);
CREATE INDEX IF NOT EXISTS journey_steps_email_key ON journey_steps (email_key);
CREATE INDEX IF NOT EXISTS journey_steps_step_at ON journey_steps (step, at);

-- Refs that must never become a step again: a test booking or a test payment, once its steps are deleted, would otherwise be
-- read back from its source row. The setup procedure inserts a ref here before it deletes the step (why says what it was).
CREATE TABLE IF NOT EXISTS journey_excluded_refs (
  ref   text PRIMARY KEY,
  why   text,
  at    timestamptz NOT NULL DEFAULT now()
);

-- The views, dropped in dependency order and created again below (see the header).
DROP VIEW IF EXISTS visit_steps_by_source, funnel_by_source, journey_first_touch, journey_step_sources, journey_resolved_steps, journey_email_visitor;

-- Which visitor an email belongs to: the earliest visitor a step with that email_key carries. A proof's step is no visitor's.
CREATE OR REPLACE VIEW journey_email_visitor AS
SELECT DISTINCT ON (email_key) email_key, visitor
FROM journey_steps
WHERE email_key IS NOT NULL AND visitor IS NOT NULL AND NOT is_proof
ORDER BY email_key, at, id;

-- Every step with its person: its visitor, or the visitor its email joins to, or the email itself, or the touch it came
-- from (a step kept without consent has no visitor, only the touch id of the link it followed). A sale with only an email
-- still counts, under its email. A proof's step (is_proof) is counted by no view.
CREATE OR REPLACE VIEW journey_resolved_steps AS
SELECT s.*, COALESCE(
  s.visitor,
  e.visitor,
  CASE WHEN s.email_key IS NOT NULL THEN 'email:' || s.email_key END,
  CASE WHEN s.touch_id IS NOT NULL THEN 'touch:' || s.touch_id END
) AS person
FROM journey_steps s
LEFT JOIN journey_email_visitor e ON s.visitor IS NULL AND s.email_key = e.email_key
WHERE NOT s.is_proof AND (s.ref IS NULL OR s.ref NOT IN (SELECT ref FROM journey_excluded_refs));

-- The first touch of each person: the earliest step that carries a tracked source (a UTM field or an ad click id). A lead's
-- self-reported answer is a source but not a touch, so it never decides where a person came from.
-- A step that followed a tracked link carries that link's source (journey_touches.source) when the step has none of its own.
CREATE OR REPLACE VIEW journey_step_sources AS
SELECT r.*, COALESCE(NULLIF(r.source, '{}'::jsonb), t.source, '{}'::jsonb) AS step_source
FROM journey_resolved_steps r
LEFT JOIN journey_touches t ON t.id = r.touch_id;

CREATE OR REPLACE VIEW journey_first_touch AS
SELECT DISTINCT ON (person) person AS visitor, touch_id, step_source AS source, at
FROM journey_step_sources
WHERE person IS NOT NULL
  AND step_source ?| array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'fbc', 'msclkid', 'ttclid', 'twclid', 'li_fat_id', 'rdt_cid', 'ScCid', 'epik']
ORDER BY person, at, id;

-- Each person's counts and revenue, grouped by the first touch's utm_source, utm_medium and utm_campaign. A person with
-- no first touch falls in the group with those fields null: the unknown source. Each count is people who took that step.
CREATE OR REPLACE VIEW funnel_by_source AS
WITH per_person AS (
  SELECT
    person,
    bool_or(step = 'click') AS clicked,
    bool_or(step = 'visit') AS visited,
    bool_or(step = 'lead') AS led,
    bool_or(step = 'booking') AS booked,
    bool_or(step = 'checkout') AS checked_out,
    bool_or(step = 'sale') AS sold,
    COALESCE(sum(value_cents) FILTER (WHERE step = 'sale'), 0) AS revenue_cents
  FROM journey_resolved_steps
  WHERE person IS NOT NULL
  GROUP BY person
),
tagged AS (
  SELECT
    p.*,
    ft.source->>'utm_source' AS utm_source,
    ft.source->>'utm_medium' AS utm_medium,
    ft.source->>'utm_campaign' AS utm_campaign
  FROM per_person p
  LEFT JOIN journey_first_touch ft ON ft.visitor = p.person
)
SELECT
  utm_source,
  utm_medium,
  utm_campaign,
  count(*) AS visitors,
  count(*) FILTER (WHERE clicked) AS clicks,
  count(*) FILTER (WHERE visited) AS visits,
  count(*) FILTER (WHERE led) AS leads,
  count(*) FILTER (WHERE booked) AS bookings,
  count(*) FILTER (WHERE checked_out) AS checkouts,
  count(*) FILTER (WHERE sold) AS sales,
  sum(revenue_cents) AS revenue_cents
FROM tagged
GROUP BY utm_source, utm_medium, utm_campaign;

-- Every visit step counted by the source it carries: the step's own UTM fields, or the tracked link's (journey_touches) when the
-- step has none. A visit with no person (a visitor who did not consent and came without a touch) counts here and nowhere else,
-- so a post's visits show even when no person is kept. The people counts in funnel_by_source are unchanged.
CREATE OR REPLACE VIEW visit_steps_by_source AS
  SELECT COALESCE(s.source->>'utm_source', t.source->>'utm_source') AS utm_source,
         COALESCE(s.source->>'utm_medium', t.source->>'utm_medium') AS utm_medium,
         COALESCE(s.source->>'utm_campaign', t.source->>'utm_campaign') AS utm_campaign,
         count(*) AS visit_steps
    FROM journey_steps s
    LEFT JOIN journey_touches t ON t.id = s.touch_id
   WHERE s.step = 'visit' AND NOT s.is_proof
   GROUP BY 1, 2, 3;
