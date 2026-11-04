// src/work-media-session.mjs
//
// THE MEDIA EDITOR'S SESSION, ITS PUBLISHED VERSIONS AND ITS TRACK CHECK, ON THE PERSON'S OWN STORE.
//
//   POST /work/api/media/session    { id, command | undo | redo }   the edit's state after one logged command
//   GET  /work/api/media/session?id=<edit>                            the state, as replayed from the newest snapshot
//   GET  /work/api/media/versions?id=<recording>                      the versions state
//   POST /work/api/media/versions   { id, action, ... }               publish / default / remove / serve one version
//   POST /work/api/media/alignment  { tracks }                        are the separate tracks of a recording in step
//
// Purpose: an edit changes many times, and a tab closed mid-edit must lose nothing (edit-command-log.mjs); an edit becomes a
// version beside the untouched original, one of which the person chooses as the default (media-versions.mjs); and a recording of
// separate tracks only plays right if they line up (track-alignment.mjs). This binds those three pure modules to the person's
// store; none of their rules is repeated here.
//
// Non-negotiable invariants:
//   1. The page session is already established; every read and write is that person's own facts. A write needs the service's own origin.
//   2. A command is appended to the log before its state is answered; an append that fails answers an error and changes nothing.
//   3. A command changes the edit's state only through a path operation named in DATA (./work-media-session.json); no command type is named in code.
//   4. Versions and the log are bounded: ids, paths, values, tracks and kept entries are checked against DATA limits.
import rules from '../../shared-code/src/work-media-session.json' with { type: 'json' };
import { openEditLog } from '../../media-composition/read-data/edit-command-log.mjs';
import { canPublish, newVersionsState, publishVersion, removeVersion, setDefaultVersion, versionServed } from '../../media-composition/read-data/media-versions.mjs';
import { measureAlignment } from '../../media-composition/read-data/track-alignment.mjs';

const SESSION = '/work/api/media/session';
const VERSIONS = '/work/api/media/versions';
const ALIGNMENT = '/work/api/media/alignment';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store' } });
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const keyOf = (name, id) => fill(rules.facts[name], { id });

export const isMediaSessionPath = path => [SESSION, VERSIONS, ALIGNMENT].includes(path);

const owns = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const holderOf = (state, path) => path.slice(0, -1).reduce((current, key) => (owns(current, key) ? current[key] : undefined), state);

/** How each way of changing a path is done, by the `how` name DATA gives a command. */
const HOW = {
  set: (holder, key, command) => { holder[key] = command.value; },
  unset: (holder, key) => { if (Array.isArray(holder)) holder.splice(Number(key), 1); else delete holder[key]; },
  insert: (holder, key, command) => { holder[key].splice(command.index, 0, command.value); },
  remove: (holder, key, command) => { holder[key].splice(command.index, 1); },
};

/** A command checked against DATA: the reason it is refused, or null. */
export function commandProblem(command, settings = rules) {
  const row = owns(command, 'type') && typeof command.type === 'string' && owns(settings.commands, command.type) ? settings.commands[command.type] : null;
  if (!row) return 'the command is not one this editor has';
  for (const field of row.needs) if (!owns(command, field)) return `a ${command.type} needs ${field}`;
  if (!Array.isArray(command.path) || !command.path.length || command.path.length > settings.most_path || !command.path.every((key) => typeof key === 'string' || Number.isInteger(key))) return 'the path is not a list of names';
  if (command.path.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) return 'that path name is not allowed';
  if (JSON.stringify(command.value ?? null).length > settings.most_value_bytes) return 'the value is too large';
  return null;
}

/** The pure reducer the log folds: one DATA-named path operation applied to a copy of the state. */
export function reduceEdit(state, command, settings = rules) {
  const next = structuredClone(state);
  const holder = holderOf(next, command.path);
  const key = command.path.at(-1);
  if (holder === undefined || holder === null || typeof holder !== 'object') return state;
  HOW[settings.commands[command.type].how](holder, key, command);
  return next;
}

/** The log's store on the person's facts: commands after the newest snapshot, and that snapshot. */
function factStore(person, settings) {
  return {
    async append(session, entry) {
      const log = (await person.fact(keyOf('log', session))) ?? [];
      await person.setFact(keyOf('log', session), [...log, entry].slice(-settings.most_log_entries));
    },
    async putSnapshot(session, snapshot) {
      await person.setFact(keyOf('snapshot', session), snapshot);
      await person.setFact(keyOf('log', session), []);
    },
    latestSnapshot: async (session) => (await person.fact(keyOf('snapshot', session))) ?? null,
    entriesAfter: async (session, seq) => ((await person.fact(keyOf('log', session))) ?? []).filter((entry) => entry.seq > seq),
  };
}

async function session(request, { person, userId, origin, url }, settings) {
  const id = request.method === 'GET' ? url.searchParams.get('id') : null;
  let body = null;
  if (request.method === 'POST') {
    if (request.headers.get('origin') !== origin) return json({ error: settings.words.not_allowed }, 403);
    body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: settings.words.bad_body }, 400);
  } else if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  const editId = id ?? body?.id;
  if (typeof userId !== 'string' || !userId) return json({ error: settings.words.sign_in }, 401);
  if (typeof editId !== 'string' || !new RegExp(settings.id_pattern, 'u').test(editId)) return json({ error: settings.words.choose_edit }, 400);
  const initial = (await person.fact(keyOf('edit', editId))) ?? {};
  const log = await openEditLog({ session: editId, store: factStore(person, settings), reduce: (state, command) => reduceEdit(state, command, settings), initial });
  if (request.method === 'GET') return json({ state: log.state(), seq: log.seq() });
  try {
    if (body.undo === true) return json({ state: await log.undo(), seq: log.seq() });
    if (body.redo === true) return json({ state: await log.redo(), seq: log.seq() });
    const why = commandProblem(body.command, settings);
    if (why) return json({ error: fill(settings.words.bad_command, { why }) }, 400);
    return json({ state: await log.apply(body.command), seq: log.seq() });
  } catch {
    return json({ error: settings.words.stored }, 500);
  }
}

async function versions(request, { person, userId, origin, url }, settings) {
  if (typeof userId !== 'string' || !userId) return json({ error: settings.words.sign_in }, 401);
  const read = async (id) => (await person.fact(keyOf('versions', id))) ?? newVersionsState();
  const valid = (id) => typeof id === 'string' && new RegExp(settings.id_pattern, 'u').test(id);
  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!valid(id)) return json({ error: settings.words.choose_edit }, 400);
    const state = await read(id);
    return json({ state, served: versionServed(state, url.searchParams.get('version')) });
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (request.headers.get('origin') !== origin) return json({ error: settings.words.not_allowed }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: settings.words.bad_body }, 400);
  if (!valid(body.id)) return json({ error: settings.words.choose_edit }, 400);
  const state = await read(body.id);
  const now = new Date().toISOString();
  const actions = {
    can_publish: () => ({ ...canPublish(state, { seconds: Number(body.seconds), now }), state }),
    publish: () => publishVersion(state, { id: String(body.version?.id ?? ''), label: String(body.version?.label ?? ''), title: body.version?.title, summary: body.version?.summary, seconds: Number(body.seconds), now, make_default: body.make_default === true }),
    default: () => setDefaultVersion(state, String(body.version_id ?? '')),
    remove: () => removeVersion(state, String(body.version_id ?? '')),
  };
  if (!owns(actions, body.action)) return json({ error: settings.words.unknown_action }, 400);
  const result = actions[body.action]();
  if (result.ok && body.action !== 'can_publish') await person.setFact(keyOf('versions', body.id), result.state);
  return json(result, result.ok ? 200 : 409);
}

async function alignment(request, { origin }, settings) {
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (request.headers.get('origin') !== origin) return json({ error: settings.words.not_allowed }, 403);
  const body = await request.json().catch(() => null);
  const tracks = body?.tracks;
  const good = Array.isArray(tracks) && tracks.length >= 1 && tracks.length <= settings.most_tracks
    && tracks.every((track) => typeof track?.id === 'string' && Number.isFinite(track.wall_clock_ms) && Number.isFinite(track.first_timestamp_ms));
  if (!good) return json({ error: fill(settings.words.bad_tracks, { most: settings.most_tracks }) }, 400);
  return json(measureAlignment(tracks.map(({ id, wall_clock_ms, first_timestamp_ms }) => ({ id, wall_clock_ms, first_timestamp_ms }))));
}

export function handleMediaSession(request, context, settings = rules) {
  const path = context.url.pathname;
  if (path === SESSION) return session(request, context, settings);
  if (path === VERSIONS) return versions(request, context, settings);
  if (path === ALIGNMENT) return alignment(request, context, settings);
  return Promise.resolve(json({ error: 'Not found' }, 404));
}
