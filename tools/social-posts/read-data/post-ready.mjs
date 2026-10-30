// tools/social-posts/read-data/post-ready.mjs
//
// Purpose: whether a post is ready for one place it is going, in plain words. A place's own row says what it takes
// (read-data/post-places.json `format`); the words for every finding and the kinds of file limit are DATA
// (read-data/posts.json `ready_words`, `ready_limits`). read-data/posts.mjs hands this the words exactly as they will
// be sent, the file as the post knows it, and the account as the person's connection records say it, and answers
// tool:check-a-post and tool:draft-a-post.
//
// Non-Negotiable Invariants:
//   1. Nothing here names a place, a kind of file or a setting. A new place is a row; a new kind of limit is a
//      `ready_limits` row; a new setting a place needs is an entry in that place's `format.settings`.
//   2. A limit whose fact is not known (a video's length nobody gave) is never passed or failed: it is
//      reported as not checked, in its own list, so "ready" never claims a check that did not happen.
//   3. The words counted are the words that go out: that place's own words, or the post's, with the tagged link.
//   4. Reading changes nothing.
//
// Key Concepts: a finding is { check, said }. `problems` stop the place taking the post; `not_checked` are limits
//   that could not be compared. `ready` is true only with no problems. A post going nowhere yet is never ready: its
//   check says to pick where it goes and lists what it can pick from (`pick_from`: connected accounts, places to connect).
//

const fill = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const listed = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
const characters = value => [...String(value ?? '')].length;

// How a number of each unit is written for a person. A unit is the kind of quantity, not a place's vocabulary.
const WRITTEN = {
  bytes: value => (value >= 1024 ** 3 ? `${Math.round((value / 1024 ** 3) * 10) / 10} GB` : value >= 1024 ** 2 ? `${Math.round((value / 1024 ** 2) * 10) / 10} MB` : `${Math.max(1, Math.round(value / 1024))} KB`),
  seconds: value => (value >= 60 ? `${Math.floor(value / 60)} min ${Math.round(value % 60)} s` : `${Math.round(value * 10) / 10} seconds`),
  shape: value => `${Math.round(value * 100) / 100} wide for each 1 tall`,
};
const written = (unit, value) => (WRITTEN[unit] ?? String)(value);

/** The facts a check can compare, from the file and anything the post was told about it. */
export function mediaFacts(file, told = {}) {
  const facts = { ...(Number.isFinite(file?.byte_length) ? { byte_length: file.byte_length } : {}) };
  for (const key of ['duration_seconds', 'width', 'height']) if (Number.isFinite(told?.[key]) && told[key] > 0) facts[key] = told[key];
  if (facts.width && facts.height) facts.aspect = facts.width / facts.height;
  return facts;
}

/**
 * One place's ready check.
 * @param {object} given
 * @param {object|null} given.place    the place's row (null: the account is not one any place row posts to any more)
 * @param {object|null} given.account  the account as destinations() lists it ({ ready, said }), null when not connected
 * @param {string} given.words         the words as they will be sent there
 * @param {object} given.chosen        the settings as they will be sent there (the place's defaults, then the post's)
 * @param {object|null} given.media    { found, media_type, facts } for the post's file, or null when it has none
 * @param {object} given.settings      read-data/posts.json
 */
export function readyFor({ place, account, words, chosen = {}, media, settings }) {
  const say = settings.ready_words;
  const platform = place?.label ?? 'this place';
  const problems = [];
  const notChecked = [];
  const problem = (check, key, values = {}) => problems.push({ check, said: fill(say[key], { platform, ...values }) });

  if (!place || !account) problem('connected', 'not_connected');
  else if (account.ready === false) problem('connected', 'not_ready', { said: account.said ?? '' });

  const format = place?.format ?? {};
  const kinds = Object.keys(format.media_kinds ?? {});
  const kind = media?.media_type ? media.media_type.split('/')[0] : media ? 'file' : null;
  const rules = (kind && format.media_kinds?.[kind]) ?? {};

  if (!media && format.media_needed) problem('media', 'needs_media');
  if (media && !media.found) problem('media', 'media_gone', { kind });
  // A place whose format lists no kind of file at all (an empty media_kinds) takes words only.
  if (media?.found && format.media_kinds && !kinds.length) problem('media', 'takes_no_files');
  if (media?.found && kinds.length && !kinds.includes(kind)) problem('media', 'kind_not_taken', { kind, media_type: media.media_type, kinds: listed(kinds) });
  if (media?.found && kinds.includes(kind)) {
    const types = rules.media_types ?? [];
    if (types.length && !types.includes(media.media_type)) problem('media', 'type_not_taken', { kind, media_type: media.media_type, types: listed(types) });
    for (const row of settings.ready_limits) {
      const limit = rules[row.limit];
      if (!Number.isFinite(limit)) continue;
      const value = media.facts?.[row.fact];
      const values = { kind, fact_name: row.fact_name, limit: written(row.unit, limit) };
      if (!Number.isFinite(value)) { notChecked.push({ check: row.limit, said: fill(say.not_known, { platform, ...values }) }); continue; }
      const kept = row.keeps === 'at_most' ? value <= limit : value >= limit;
      if (!kept) problem(row.limit, row.keeps, { ...values, value: written(row.unit, value) });
    }
  }

  const max = rules.caption_max_characters ?? format.caption_max_characters;
  const count = characters(words);
  if (Number.isFinite(max) && count > max) problem('words', 'too_many_characters', { count, max });

  for (const need of format.settings ?? []) {
    const value = chosen[need.setting];
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === undefined || text === null || text === '') {
      if (need.needed) problem(need.setting, 'setting_missing', { name: need.name });
      continue;
    }
    if (Number.isFinite(need.max_characters) && characters(text) > need.max_characters) problem(need.setting, 'setting_too_long', { name: need.name, count: characters(text), max: need.max_characters });
    const refused = [...(need.refuses_characters ?? '')].filter(character => String(text).includes(character));
    if (refused.length) problem(need.setting, 'setting_refused_characters', { name: need.name, characters: listed(refused) });
  }

  return {
    ready: problems.length === 0, problems, not_checked: notChecked,
    said: problems.length ? problems.map(item => item.said).join(' ') : fill(say.ready, { platform }),
  };
}

/** The post's check as a whole, from each destination's. */
export function readyOverall(destinations, settings, places = { connected: [], not_connected: [] }) {
  // A post going nowhere yet is not ready, and says where it can go: an account already connected, or a place to connect.
  if (!destinations.length) {
    const connected = places.connected.map(item => (item.name ? `${item.label} (${item.name})` : item.label ?? item.account_id));
    const toConnect = places.not_connected.map(item => item.label ?? item.platform);
    const said = connected.length ? fill(settings.ready_words.pick_places, { places: listed(connected) })
      : toConnect.length ? fill(settings.ready_words.connect_places, { platforms: listed(toConnect) }) : settings.ready_words.no_places;
    return { ready: false, said, pick_from: { connected: places.connected, not_connected: places.not_connected } };
  }
  const waiting = destinations.filter(item => !item.ready);
  return {
    ready: waiting.length === 0,
    said: waiting.length ? fill(settings.ready_words.some_not_ready, { platforms: listed(waiting.map(item => item.label ?? item.platform ?? item.account_id)) }) : settings.ready_words.all_ready,
  };
}
