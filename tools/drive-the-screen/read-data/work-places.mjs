// tools/drive-the-screen/read-data/work-places.mjs
//
// PURPOSE
//   The places on this computer the person shares with their AIs (this Mac's own desktop), and the person's hold on them:
//   the host's `place` seam (computer/mac-tools.mjs runHere) asks before an AI acts on a place and marks when it is done,
//   and the person takes a place over and hands it back from their own command line.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this file names no place, program or word. A kind of place is a row of tools/drive-the-screen/read-data/work-places.json; a kind
//      with `singleton` exists without being made.
//   2. Take over is the person's: while they have a place, every AI action there (a drive of the screen through the
//      host's `place` seam) is refused with when it ends. A take-over always ends by itself (its `until` is required and
//      at most longest_take_over_minutes away), so it can never lock the AIs out for good. Handing back needs the key
//      given at take over (kept here only as its BLAKE3), so an AI that did not take the place cannot hand it back. The
//      next AI action after a hand back is told once that the person had it, and when. Where the person's own keyboard
//      and pointer reach a place (its kind's `person_input`), their input also holds it for idle_ttl_ms after their last
//      input, without any take-over: input the AI's own action made is not theirs.
//   3. Bounded: every wait and length is a limit in the DATA. A places file that cannot be read is never replaced
//      (tools/drive-the-screen/read-data/settings-file.mjs).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettingsFile, writeSettingsFile } from './settings-file.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const placeSettings = () => JSON.parse(readFileSync(join(HERE, 'work-places.json'), 'utf8'));
const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const expand = (path, home) => String(path).replace(/^~(?=\/|$)/, home);
const hex = bytes => bytesToHex(blake3(bytes));
const refuse = (settings, key, values = {}, status = 400, extra = {}) => Object.assign(new Error(fill(settings.words[key], values)), { status, ...extra });

/** Runs one argv to its end: { code, stdout (bytes), stderr }. Never throws for a program that fails or is missing. */
const execStep = (argv, { timeout, maxBuffer }) => new Promise(resolve => {
  execFile(argv[0], argv.slice(1), { timeout, maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => resolve({
    code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout ?? Buffer.alloc(0),
    stderr: String(stderr?.length ? stderr : error?.message ?? ''),
  }));
});

/** The places of this computer. Reading the person's input goes through `exec`, so a test drives it without a Mac. */
export function makePlaces({ settings = placeSettings(), home = homedir(), now = () => Date.now(), exec = execStep,
  key = () => randomBytes(24).toString('base64url') } = {}) {
  const limits = settings.limits;
  const file = expand(settings.file, home);
  const accept = value => Boolean(value) && typeof value === 'object' && value.places && typeof value.places === 'object';
  const local = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const read = () => {
    const found = readSettingsFile(file, { accept });
    if (found.state === 'degraded') throw refuse(settings, 'kept_file', { error: found.why }, 409);
    return found.state === 'ok' ? found.value : { places: {} };
  };
  const write = value => writeSettingsFile(file, value, { accept });
  const singletons = () => Object.entries(settings.kinds).filter(([, kind]) => kind.singleton)
    .map(([id]) => ({ id, name: id, kind: id }));
  const all = kept => ({ ...Object.fromEntries(singletons().map(place => [place.id, place])), ...kept.places });

  /** One place by id or name, with its kind row, or a refusal naming the places there are. */
  const find = (kept, wanted) => {
    const places = all(kept);
    const place = places[wanted] ?? Object.values(places).find(item => item.name === wanted);
    if (!place) throw refuse(settings, 'unknown_place', { place: wanted, places: Object.values(places).map(item => item.name).join(', ') }, 404);
    return { place, kind: settings.kinds[place.kind] };
  };

  /** How long since the person's last keyboard or pointer input on this Mac, in ms, or null when it cannot be read. */
  const personIdle = async () => {
    const row = settings.person_input;
    const result = await exec(row.argv, { timeout: limits.step_timeout_ms, maxBuffer: limits.output_bytes * 16 });
    const found = result.code === 0 ? new RegExp(row.pattern).exec(result.stdout.toString('utf8')) : null;
    return found ? Number(found[1]) / row.units_per_ms : null;
  };

  /** Throws while the person has the place (invariant 2); otherwise marks the AI acting there and answers the once-only
   *  hand-back notice, or null. */
  const handsOn = async (kept, place, kind) => {
    const record = kept.places[place.id] ?? { ...place };
    const lease = record.lease;
    if (lease && Date.parse(lease.until) > now()) {
      throw refuse(settings, 'person_has_it', { place: place.name, since: local(Date.parse(lease.since)), until: local(Date.parse(lease.until)) }, 423,
        { reaction: 'retry', retry: true, retry_after_ms: Date.parse(lease.until) - now() });
    }
    if (kind.person_input) {
      const idle = await personIdle();
      const input = idle === null ? null : now() - idle;
      const slack = limits.acted_slack_ms;
      const theAis = input !== null && record.acting && input >= Date.parse(record.acting.since) - slack && input <= Date.parse(record.acting.until ?? record.acting.since) + slack;
      if (input !== null && !theAis && idle < limits.idle_ttl_ms) {
        throw refuse(settings, 'person_using_it', { place: place.name, seconds: Math.round(idle / 1000), ttl: Math.round(limits.idle_ttl_ms / 1000) }, 423,
          { reaction: 'retry', retry: true, retry_after_ms: Math.ceil(limits.idle_ttl_ms - idle) });
      }
    }
    record.acting = { since: new Date(now()).toISOString() };
    const back = record.handed_back;
    const notice = back && !back.told
      ? fill(settings.words.told_handed_back, { place: place.name, since: local(Date.parse(back.since)), until: local(Date.parse(back.at)), note: back.note ? `: "${back.note}"` : '' })
      : null;
    if (notice) back.told = new Date(now()).toISOString();
    kept.places[place.id] = record;
    write(kept);
    return notice;
  };
  /** Marks the end of an AI action on a place, so input it made is never read as the person's. */
  const acted = placeId => {
    const kept = read();
    if (!kept.places[placeId]?.acting) return;
    kept.places[placeId].acting.until = new Date(now()).toISOString();
    write(kept);
  };

  return {
    /** The person takes the place over: AIs are refused there until they hand it back or `until` passes. */
    async take_over(input = {}) {
      const kept = read();
      const { place } = find(kept, String(input.place ?? ''));
      const current = kept.places[place.id]?.lease;
      if (current && Date.parse(current.until) > now()) throw refuse(settings, 'already_taken', { place: place.name, until: local(Date.parse(current.until)) }, 409);
      const minutes = Math.min(Number(input.minutes) > 0 ? Number(input.minutes) : limits.default_take_over_minutes, limits.longest_take_over_minutes);
      const handBack = key();
      const record = kept.places[place.id] ?? { ...place };
      record.lease = { holder: 'person', since: new Date(now()).toISOString(), until: new Date(now() + minutes * 60_000).toISOString(), key: hex(new TextEncoder().encode(handBack)) };
      delete record.handed_back;
      kept.places[place.id] = record;
      write(kept);
      return { place: place.name, until: record.lease.until, hand_back_key: handBack, said: fill(settings.words.taken_over, { place: place.name, until: local(Date.parse(record.lease.until)) }) };
    },

    /** The person hands the place back with the key they were given; the next AI action there is told. */
    async hand_back(input = {}) {
      const kept = read();
      const { place } = find(kept, String(input.place ?? ''));
      const lease = kept.places[place.id]?.lease;
      if (!lease) throw refuse(settings, 'not_taken', { place: place.name }, 409);
      const given = Buffer.from(hex(new TextEncoder().encode(String(input.key ?? ''))));
      if (!timingSafeEqual(given, Buffer.from(lease.key))) throw refuse(settings, 'wrong_key', { place: place.name }, 403);
      const note = typeof input.note === 'string' ? input.note.slice(0, limits.note_chars) : '';
      kept.places[place.id].handed_back = { since: lease.since, at: new Date(now()).toISOString(), ...(note ? { note } : {}) };
      delete kept.places[place.id].lease;
      write(kept);
      return { place: place.name, said: fill(settings.words.handed_back, { place: place.name }) };
    },

    /** The host's seam (computer/mac-tools.mjs): refuses an AI action on `placeId` while the person has it or is using
     *  it; else marks the AI acting there and answers the once-only hand-back notice. `acted` marks the action's end. */
    async handsOn(placeId) {
      const kept = read();
      const { place, kind } = find(kept, placeId);
      return handsOn(kept, place, kind);
    },
    acted,
  };
}

// The person's own command line on this Mac: take a place over (the key is kept 0600 under the places folder, never
// printed) and hand it back with that key.
//   node tools/drive-the-screen/read-data/work-places.mjs take-over <place> [minutes]
//   node tools/drive-the-screen/read-data/work-places.mjs hand-back <place> [note]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [verb, place, extra] = process.argv.slice(2);
  const settings = placeSettings();
  const keys = join(expand(settings.folder, homedir()), 'keys');
  const keyFile = join(keys, `${String(place).replace(/[^a-z0-9-]/g, '_')}.key`);
  const places = makePlaces({ settings });
  const answer = verb === 'take-over'
    ? places.take_over({ place, minutes: Number(extra) || undefined }).then(({ hand_back_key, ...rest }) => {
      mkdirSync(keys, { recursive: true, mode: 0o700 });
      writeFileSync(keyFile, hand_back_key, { mode: 0o600 });
      return rest;
    })
    : verb === 'hand-back'
      ? places.hand_back({ place, key: readFileSync(keyFile, 'utf8'), note: extra }).then(done => { rmSync(keyFile, { force: true }); return done; })
      : Promise.reject(new Error('Say take-over <place> [minutes] or hand-back <place> [note].'));
  answer.then(done => console.log(done.said), error => { console.error(error.message); process.exitCode = 1; });
}
