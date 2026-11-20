// src/reader.mjs
//
// Purpose: the continuous reading. Everything that comes in for a person is read as it arrives, and one picture of them
// is kept: what they are pursuing and where it is heading, their traits, whether each pursuit is worthwhile, each thing
// found walked through the framework's stages, and whether what they are doing right now is on their path. Ported from
// awarenessReader (src/awareness.mjs:360-500 of the old repository, commit b6ae0ebf8).
//
// Non-Negotiable Invariants:
//   1. Every stage, trait, judgement, choice, limit and word is a row of the settings the caller hands in; nothing here
//      names one. The model is asked for exactly the ids those rows name, and a reply is kept only in that shape.
//   2. Each reading starts from the picture so far plus the inputs since the last reading (inputs.mjs: new ones first,
//      then older history until all of it was read once). The cursor moves only after the new picture is kept: a reading
//      that throws is read again, never lost. A reading no AI answered waits twice as long as the one before it, up to
//      waiting_longest_minutes, and one answer starts the count again.
//   3. It reads only for a person whose plan keeps their records (`allowed`), and only when there is something unread;
//      readings_per_day bounds it whatever comes in.
//   4. What it says rests on the inputs: a reply with no trajectory is refused. It never acts and never sends anything.
//
// Seams (every store is injected; this file runs no SQL itself):
//   settings    the awareness rows (content the caller hands in)
//   allowed()   whether this person's plan keeps their records
//   reading     { read(), write(value) }  cursor, last reading, readings today, waiting state
//   pending     { read(), write(value) }  the unanswered request, kept until its answer is kept
//   picture     { read(), write(value) }  the picture so far
//   inputs      inputs.mjs awarenessInputs(...) : { unread(cursor), read(cursor, limits) }
//   ask         askAwarenessModel(...) (ask-model.mjs): async (system, user) => { reply, model }
//   stated      async () => the pursuits the person recorded
//   record      async (pursuits) => records them (engine.recordPursuits) or null
//   questions   awarenessQuestions(...) (questions.mjs) or null
//   map         { list_id, areas(), offered?() } over the person's map rows, or null
//   mapSettings the map's reading words ({ reading: { ask, look } }), required with map
//   consolidate { runDue(), last() } or null: tidies pursuits after a reading that recorded; never throws
//   mergedAway  async () => ids of pursuits a consolidation merged away, or null
//
// Shapes kept: see picture.mjs (shapePicture) and found-pursuits.mjs (foundPursuits).

import { keptAreas, mapForReading, placeOnMap } from '../../place-pursuits-on-a-life-map/src/life-map.mjs';
import { awarenessPrompt, mergePicture, reviewTraitHistory, shapePicture, text, list } from './picture.mjs';
import { foundPursuits } from './found-pursuits.mjs';
import { keepFound } from './record-found.mjs';
import { NotJson, replyObject, replyText } from './reply.mjs';

const DAY = iso => iso.slice(0, 10);

export function awarenessReader({ settings, allowed, reading, pending, picture, inputs, ask, stated = async () => [], record = null,
  questions = null, map = null, mapSettings = null, consolidate = null, mergedAway = null, now = () => new Date() }) {
  if (!pending?.read || !pending?.write) throw new TypeError('A reading needs a store for its unanswered request.');
  if (map && !mapSettings) throw new TypeError('A reading with a map needs the map settings.');

  const state = async () => {
    const kept = (await reading.read()) ?? {};
    const today = DAY(now().toISOString());
    return {
      cursor: kept.cursor ?? null, last_read_at: kept.last_read_at ?? null, read_count: kept.read_count ?? 0,
      waiting_until: kept.waiting_until ?? null, waiting_reason: kept.waiting_reason ?? null, waiting_misses: kept.waiting_misses ?? 0,
      day: today, today: kept.day === today ? kept.today ?? 0 : 0,
    };
  };

  // When the next reading is due: never without something unread, at most every_minutes, at most readings_per_day.
  async function nextDue() {
    if (!(await allowed())) return null;
    const kept = await state();
    const due = unread => {
      if (!unread) return null;
      if (kept.today >= settings.readings_per_day) return Date.parse(`${kept.day}T00:00:00.000Z`) + 86_400_000;
      const last = kept.last_read_at ? Date.parse(kept.last_read_at) : 0;
      return Math.max(now().getTime(), last + settings.every_minutes * 60_000, Date.parse(kept.waiting_until) || 0);
    };
    if (await pending.read()) return due(true);
    return due(await inputs.unread(kept.cursor));
  }

  // One reading, or the wait it is in. A reading no AI answered (NoChosenAI from the routing owner) waits longer each time.
  async function runDue() {
    if (!(await allowed())) return { read: false };
    const kept = await state();
    if (Date.parse(kept.waiting_until) > now().getTime()) return { read: false, waiting: true, retry_at: kept.waiting_until };
    try { return await readDue(); } catch (error) {
      if (!error?.no_chosen_ai) throw error;
      const misses = kept.waiting_misses + 1;
      const minutes = Math.min(settings.every_minutes * 2 ** (misses - 1), Math.max(settings.every_minutes, settings.waiting_longest_minutes ?? settings.every_minutes));
      const retry_at = new Date(now().getTime() + minutes * 60_000).toISOString();
      await reading.write({ ...kept, waiting_until: retry_at, waiting_misses: misses, waiting_reason: 'No AI answered this reading. It will retry automatically.' });
      return { read: false, waiting: true, retry_at };
    }
  }

  async function readDue() {
    if (!(await allowed())) return { read: false };
    const kept = await state();
    if (kept.today >= settings.readings_per_day) return { read: false, limit: true };
    const at = now().toISOString();
    let request = await pending.read();
    // The cursor commit may survive a crash before the pending setting is cleared. Do not count that batch twice.
    if (request && kept.read_count >= request.read_count + request.items && JSON.stringify(kept.cursor) === JSON.stringify(request.cursor)) {
      await pending.write(null);
      return { read: false };
    }
    const found = request ? null : await inputs.read(kept.cursor, settings.inputs);
    if (found && !found.items.length) {
      await reading.write({ cursor: found.cursor, last_read_at: kept.last_read_at, read_count: kept.read_count, day: kept.day, today: kept.today });
      return { read: false };
    }
    const stored = await picture.read();
    const reviewed = settings.trait_evidence ? reviewTraitHistory(stored, settings) : { picture: stored, unverified_traits: {} };
    const before = reviewed.picture;
    const sofar = before ? {
      trajectory: text(before.trajectory, settings.inputs?.picture_chars ?? settings.kept.chars),
      traits: Object.fromEntries(settings.traits.map(({ id }) => [id, list(before.traits?.[id]).map(item => item.name).slice(0, 3)])),
      pursuits: list(before.pursuits).map(item => ({ title: item.title, recorded: item.recorded })),
      right_now: before.right_now?.doing ?? null,
    } : null;
    const areas = map ? await map.areas() : null;
    const recorded = await stated();
    const said = recorded.slice(0, settings.inputs.stated_pursuits)
      .map((item, index) => ({
        ...(settings.recording && item.id ? { id: item.id } : {}), title: text(item.title, 160),
        ...(index < 6 ? { now: text(item.now, settings.inputs?.stated_chars ?? settings.kept.chars), after: text(item.after, settings.inputs?.stated_chars ?? settings.kept.chars) } : {}),
        ...(areas && Array.isArray(item.areas) ? { areas: keptAreas(item.areas, areas) } : {}),
      }))
      .filter(item => item.title);
    const answers = questions && settings.questions ? (await questions.asked()).map((row, index) =>
      (index < 8 ? row : { question: text(row.question, 120), answer: row.answer ? '(answered earlier)' : '' })) : null;
    const mapAreas = areas ? mapForReading(areas).map(row => ({ ...row, means: text(row.means, 100) })) : null;
    if (!request) {
      request = {
        system: awarenessPrompt(settings, { map: Boolean(areas), mapSettings }),
        user: JSON.stringify({ picture_so_far: sofar, pursuits_they_recorded: said, ...(answers ? { answers_they_gave: answers } : {}), ...(mapAreas ? { map_areas: mapAreas } : {}), new_inputs: found.items }),
        cursor: found.cursor, read_count: kept.read_count, items: found.items.length, counts: found.counts,
      };
      // Keep this bounded batch before asking, so a cold boot consumes the answer to precisely the inputs it selected.
      await pending.write(request);
    }
    const { reply, model } = await ask(request.system, request.user);
    const shaped = shapePicture(await validReply(reply), settings, {
      areas, keepAreas: keptAreas, recorded: new Set(said.map(item => item.id).filter(Boolean)),
      sources: settings.trait_evidence ? JSON.parse(request.user).new_inputs ?? [] : null,
    });
    if (!shaped) throw new Error('The reading came back without a trajectory, so the picture was kept as it was.');
    const merged = mergePicture(before, shaped, settings);
    const read_count = request.read_count + request.items;
    const { questions: asking, ...kept_picture } = merged;
    await picture.write({ ...kept_picture, ...(Object.keys(reviewed.unverified_traits).length ? { unverified_traits: reviewed.unverified_traits } : {}), read_at: at, read_count, model });
    const asked = questions && settings.questions ? await questions.keep(asking) : { kept: 0 };
    const gone = new Set(mergedAway ? await mergedAway() : []);
    const pursuits = record && settings.recording
      ? await keepFound(record, foundPursuits(kept_picture.pursuits, recorded, { recording: settings.recording, at, mergedAway: gone }))
      : null;
    await reading.write({ cursor: request.cursor, last_read_at: at, read_count, day: kept.day, today: kept.today + 1 });
    await pending.write(null);
    // After the reading is kept, so a tidy that fails or waits leaves the reading as it was. It never throws.
    const tidied = consolidate && pursuits ? await consolidate.runDue() : null;
    return { read: true, items: request.items, counts: request.counts, questions: asked.kept, ...(pursuits ? { pursuits } : {}), ...(tidied?.ran ? { tidied } : {}) };
  }

  // The reply as an object; a model that wrapped its JSON in markdown or broke it is asked once to make it valid,
  // changing no words (repair_instructions). A second failure throws.
  async function validReply(reply) {
    try { return replyObject(reply); } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof NotJson)) throw error;
      return replyObject((await ask(settings.repair_instructions, replyText(reply))).reply);
    }
  }

  // What it figured out, and where the person's pursuits sit on their map. Their own map only: one they never chose is
  // offered (map_offer), never made for them.
  async function read() {
    const kept = await state();
    const stored = await picture.read();
    const reviewed = settings.trait_evidence ? reviewTraitHistory(stored, settings) : { picture: stored, unverified_traits: {} };
    const value = reviewed.picture ? { ...reviewed.picture,
      ...(Object.keys(reviewed.unverified_traits).length ? { unverified_traits: reviewed.unverified_traits } : {}) } : null;
    const placed = map ? await map.areas() : null;
    const recorded = placed ? (await stated()).filter(item => item?.status !== 'ended') : [];
    const due = await nextDue();
    return {
      picture: value,
      reading: {
        last_read_at: kept.last_read_at, read_count: kept.read_count,
        ...(kept.waiting_until ? { waiting_until: kept.waiting_until, waiting_reason: kept.waiting_reason } : {}),
        history_done: Boolean(kept.cursor?.history_done),
        next_read_at: due === null ? null : new Date(due).toISOString(),
      },
      ...(questions && settings.questions ? { questions: await questions.waiting() } : {}),
      ...(placed ? { map: placeOnMap(placed, recorded, { list_id: map.list_id }) } : map?.offered?.() ? { map_offer: true } : {}),
      ...(consolidate ? { consolidation: consolidate.last() } : {}),
    };
  }

  return { nextDue, runDue, read };
}
