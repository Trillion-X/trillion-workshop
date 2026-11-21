-- tools/traffic-attribution/read-data/journey-steps.sql
--
-- The journey kit's tables and views, for a pursuit's _for_who_runs_it database. Run it as often as you like: every
-- statement is idempotent. Step kinds, joins and limits are DATA in read-data/journey.json; the step names the views
-- count ('click', 'visit', 'lead', 'booking', 'checkout', 'sale') are the same words that file names.

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

CREATE UNIQUE INDEX IF NOT EXISTS journey_steps_step_ref ON journey_steps (step, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS journey_steps_visitor ON journey_steps (visitor);
CREATE INDEX IF NOT EXISTS journey_steps_email_key ON journey_steps (email_key);
CREATE INDEX IF NOT EXISTS journey_steps_step_at ON journey_steps (step, at);

-- Which visitor an email belongs to: the earliest visitor a step with that email_key carries.
CREATE OR REPLACE VIEW journey_email_visitor AS
SELECT DISTINCT ON (email_key) email_key, visitor
FROM journey_steps
WHERE email_key IS NOT NULL AND visitor IS NOT NULL
ORDER BY email_key, at, id;

-- Every step with its person: its visitor, or the visitor its email joins to, or the email itself when no visitor
-- ever carried it (so a sale with only an email still counts, under unknown).
CREATE OR REPLACE VIEW journey_resolved_steps AS
SELECT s.*, COALESCE(s.visitor, e.visitor, CASE WHEN s.email_key IS NOT NULL THEN 'email:' || s.email_key END) AS person
FROM journey_steps s
LEFT JOIN journey_email_visitor e ON s.visitor IS NULL AND s.email_key = e.email_key;

-- The first touch of each person: the earliest step that carries a tracked source (a UTM field or an ad click id). A lead's
-- self-reported answer is a source but not a touch, so it never decides where a person came from.
CREATE OR REPLACE VIEW journey_first_touch AS
SELECT DISTINCT ON (person) person AS visitor, touch_id, source, at
FROM journey_resolved_steps
WHERE person IS NOT NULL
  AND source ?| array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'fbc', 'msclkid', 'ttclid', 'twclid', 'li_fat_id', 'rdt_cid', 'ScCid', 'epik']
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
