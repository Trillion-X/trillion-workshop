// The clip gate on a real PostgreSQL engine (PGlite): the live fence functions (covers, pair_allowed, material_allowed) and the
// consent_fence row policy on recording_moment, with the query the tool runs (read-data/clips-query.mjs). A withdrawn grant hides
// a clip at the next read, an unknown person never shows, a clip for another surface never shows, and an empty result is [].
// Every name, id and recording here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { CLIPS_SQL, clipsOf, clipsParams, clipsRequest } from '../read-data/clips-query.mjs';

// The function bodies as the live ethos_for_who_runs_it database keeps them (pg_get_functiondef).
const FENCE_FUNCTIONS = `
CREATE FUNCTION covers(p text, v text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$ select p = '' or v = p or starts_with(v, p || '/') or starts_with(v, p || ':') $function$;

CREATE FUNCTION pair_allowed(s text, h text, pu text, su text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from use_grants g where g.effect = 'allow' and covers(g.subject, s) and covers(g.how, h)
                   and covers(g.purpose, pu) and covers(g.surface, su)
                   and g.given_at <= now() and (g.withdrawn_at is null or g.withdrawn_at > now())
                   and (g.holds_until is null or g.holds_until > now()))
  and not exists (select 1 from use_grants g where g.effect = 'deny' and covers(g.subject, s) and covers(g.how, h)
                   and covers(g.purpose, pu) and covers(g.surface, su)
                   and g.given_at <= now() and (g.withdrawn_at is null or g.withdrawn_at > now())
                   and (g.holds_until is null or g.holds_until > now()))
$function$;

CREATE FUNCTION material_allowed(m text, a numeric, b numeric, pu text, su text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  with subjects as (
    select s.subject, s.how from material_subjects s
     where s.material = m
       and (a is null or s.span_end is null or s.span_end > a)
       and (b is null or s.span_start is null or s.span_start < b)
    union all
    select 'unexamined', 'unexamined' where not exists (select 1 from material_subjects s where s.material = m)
  )
  select coalesce(bool_and(pair_allowed(subject, how, pu, su)), true) from subjects
$function$;
`;

// The run's claimed use, as the engine's claim gives it (run_purpose, run_surface); a test sets it per read.
const RUN_USE = `
CREATE FUNCTION run_purpose() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.run_purpose', true), '') $$;
CREATE FUNCTION run_surface() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.run_surface', true), '') $$;
`;

const TABLES = `
CREATE TABLE recording_moment (
  id text PRIMARY KEY, evidence text, moment text, spoken_words text, aa_buckets text, cut text, pillars text, recording_name text,
  timing text, relevance text, recording text, captured_day text, "end" text, start text, speaker_identity text, picture text,
  seen text, seen_at text, extra text, published_file_name text
);
CREATE TABLE material_subjects (
  id bigserial PRIMARY KEY, material text NOT NULL, span_start numeric, span_end numeric, subject text NOT NULL, how text NOT NULL,
  sure real, found_by text NOT NULL DEFAULT 'test', found_at timestamptz NOT NULL DEFAULT now(), derived_from text, made_by text
);
CREATE TABLE use_grants (
  id text PRIMARY KEY, subject text NOT NULL, how text NOT NULL, purpose text NOT NULL, surface text NOT NULL, effect text NOT NULL,
  evidence text NOT NULL, given_at timestamptz NOT NULL, withdrawn_at timestamptz, holds_until timestamptz, recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1
);
`;

// The row policy, after the functions it calls exist; the table owner is held to it too (FORCE), as a pursuit login is not exempt.
const POLICY = `
ALTER TABLE recording_moment ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_moment FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_fence ON recording_moment FOR ALL
  USING (material_allowed('recording/' || recording, NULLIF(start, '')::numeric, NULLIF("end", '')::numeric, run_purpose(), run_surface()));
`;

const READER = `
CREATE ROLE site_reader NOLOGIN;
GRANT USAGE ON SCHEMA public TO site_reader;
GRANT SELECT ON recording_moment, material_subjects, use_grants TO site_reader;
`;

// The schema in the order the database needs it: tables, then the functions they read, then the run's use and the policy.
async function setUp(database) {
  await database.exec(TABLES);
  await database.exec(FENCE_FUNCTIONS);
  await database.exec(RUN_USE);
  await database.exec(POLICY);
  // The read runs as a login that is not a superuser: a superuser bypasses row policies even when the table forces them.
  await database.exec(READER);
}

const hex = char => char.repeat(64);
const cutOf = char => `1f:${hex(char)}`;
const clipExtra = (kind, surfaces, extra = {}) => JSON.stringify({ kind, aspect: '9x16', speed: '1', surfaces, ...extra });
const SITE = [{ purpose: 'publish', surface: 'site' }];
const MEMBERS = [{ purpose: 'members', surface: 'members-page' }];

let db;

// One read as the engine's claimed use would make it: the use is set for the read, the row policy and the query both apply.
async function readAs(purpose, surface, input = {}) {
  await db.query(`SELECT set_config('test.run_purpose', $1, false), set_config('test.run_surface', $2, false)`, [purpose, surface]);
  await db.exec('SET ROLE site_reader');
  const request = clipsRequest({ purpose, surface, ...input });
  const { rows } = await db.query(CLIPS_SQL, clipsParams(request));
  return clipsOf(rows);
}

before(async () => {
  db = await PGlite.create();
  await setUp(db);
  // Ada's clip (granted for the site), Bo's clip (his grant withdrawn), Cy's clip (no grant), a members-only clip, and a
  // clip whose material has no subject rows (the fence reads it as unexamined). A published row is recording = cut = its 1f: identity.
  await db.exec(`
    INSERT INTO recording_moment (id, moment, cut, picture, recording, recording_name, start, "end", captured_day, extra) VALUES
      ('record:recording-moment:clip-ada', 'clip', '${cutOf('a')}', '${cutOf('b')}', '${cutOf('a')}', 'Ada', '', '', '2026-11-01', '${clipExtra('swing', SITE)}'),
      ('record:recording-moment:clip-bo', 'clip', '${cutOf('c')}', '${cutOf('d')}', '${cutOf('c')}', 'Bo', '', '', '2026-11-02', '${clipExtra('swing', SITE)}'),
      ('record:recording-moment:clip-cy', 'comparison', '${cutOf('e')}', '${cutOf('f')}', '${cutOf('e')}', 'Cy', '', '', '2026-11-03', '${clipExtra('comparison', SITE)}'),
      ('record:recording-moment:clip-members', 'reel', '${cutOf('1')}', '${cutOf('2')}', '${cutOf('1')}', 'Mem', '', '', '2026-11-04', '${clipExtra('reel', MEMBERS)}'),
      ('record:recording-moment:clip-unexamined', 'clip', '${cutOf('3')}', '${cutOf('4')}', '${cutOf('3')}', 'Unx', '', '', '2026-11-05', '${clipExtra('swing', SITE)}');
    UPDATE recording_moment SET published_file_name = '/published-clips/' || substr(cut, 4) || '.mp4';
    UPDATE recording_moment SET published_file_name = NULL WHERE id = 'record:recording-moment:clip-unexamined';
    INSERT INTO material_subjects (material, subject, how) VALUES
      ('recording/${cutOf('a')}', 'person:ada', 'face'),
      ('recording/${cutOf('c')}', 'person:bo', 'face'),
      ('recording/${cutOf('e')}', 'person:cy', 'face'),
      ('recording/${cutOf('1')}', 'person:ada', 'face');
    INSERT INTO use_grants (id, subject, how, purpose, surface, effect, evidence, given_at, withdrawn_at, recorded_by) VALUES
      ('g-ada', 'person:ada', '', 'publish', 'site', 'allow', 'consent-form', now() - interval '1 day', NULL, 'test'),
      ('g-bo', 'person:bo', '', 'publish', 'site', 'allow', 'consent-form', now() - interval '1 day', now() - interval '1 hour', 'test'),
      ('g-mem', 'person:ada', '', 'members', 'members-page', 'allow', 'consent-form', now() - interval '1 day', NULL, 'test');
  `);
});

after(async () => {
  await db.close();
});

test('a clip whose person holds a live grant for the surface is shown, with its Files identities', async () => {
  const clips = await readAs('publish', 'site');
  const ada = clips.find(clip => clip.id === 'record:recording-moment:clip-ada');
  assert.ok(ada, 'Ada\'s clip is shown on the site');
  assert.equal(ada.cut, cutOf('a'));
  assert.equal(ada.picture, cutOf('b'));
  assert.equal(ada.kind, 'swing');
});

test('a withdrawn grant hides the clip at the next read', async () => {
  const clips = await readAs('publish', 'site');
  assert.equal(clips.some(clip => clip.id === 'record:recording-moment:clip-bo'), false);
});

test('an unknown person with no grant never shows', async () => {
  const clips = await readAs('publish', 'site');
  assert.equal(clips.some(clip => clip.id === 'record:recording-moment:clip-cy'), false);
});

test('a clip with no subject rows is read as unexamined and never shows', async () => {
  const clips = await readAs('publish', 'site');
  assert.equal(clips.some(clip => clip.id === 'record:recording-moment:clip-unexamined'), false);
});

test('a clip granted for the members page is not shown on the site, and is shown on its own surface', async () => {
  const site = await readAs('publish', 'site');
  assert.equal(site.some(clip => clip.id === 'record:recording-moment:clip-members'), false);
  const members = await readAs('members', 'members-page');
  assert.deepEqual(members.map(clip => clip.id), ['record:recording-moment:clip-members']);
});

test('the policy alone refuses a read with no claimed use: the query answers nothing', async () => {
  await db.query(`SELECT set_config('test.run_purpose', '', false), set_config('test.run_surface', '', false)`);
  await db.exec('SET ROLE site_reader');
  const { rows } = await db.query(CLIPS_SQL, clipsParams(clipsRequest({ purpose: 'publish', surface: 'site' })));
  assert.deepEqual(rows, []);
});

test('a clip with no published file name is never answered, even when its grant is live', async () => {
  const clips = await readAs('publish', 'site');
  assert.equal(clips.some(clip => clip.id === 'record:recording-moment:clip-unexamined'), false);
});

test('an empty result is an empty list', async () => {
  const empty = await PGlite.create();
  try {
    await setUp(empty);
    await empty.query(`SELECT set_config('test.run_purpose', 'publish', false), set_config('test.run_surface', 'site', false)`);
    await empty.exec('SET ROLE site_reader');
    const { rows } = await empty.query(CLIPS_SQL, clipsParams(clipsRequest({ purpose: 'publish', surface: 'site' })));
    assert.deepEqual(clipsOf(rows), []);
  } finally {
    await empty.close();
  }
});

test('the request is checked: a purpose and surface are required, kind and limit are bounded', () => {
  assert.throws(() => clipsRequest({ surface: 'site' }), /purpose/);
  assert.throws(() => clipsRequest({ purpose: 'publish' }), /surface/);
  assert.throws(() => clipsRequest({ purpose: 'publish', surface: 'site', kind: 'nope' }), /kind/);
  assert.throws(() => clipsRequest({ purpose: 'publish', surface: 'site', limit: 101 }), /limit/);
  assert.deepEqual(clipsRequest({ purpose: 'publish', surface: 'site' }), { purpose: 'publish', surface: 'site', kind: null, limit: 24 });
});
