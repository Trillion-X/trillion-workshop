// src/inbound.mjs
//
// One door for everything a person writes somewhere else: a note, a voice memo, an email, a page in a notes app.
//
// Purpose
//   A person writes to their AIs in many places, and any one of those places can be down (an AI app disconnected,
//   a laptop asleep). Every place becomes a carrier that brings what was written here, and this step does the same
//   two things for every carrier: it keeps the words (messages.mjs, so every connected AI can read them) and it keeps
//   one `arrival` record holding the job for an agent. What happens next is the person's own rule over arrivals
//   (src/automations.mjs, run by the trigger engine): every account starts with one that hands the job to whichever
//   agent takes it first, through a workflow (records/starting-rules.json, src/starting-rules.mjs), and it can be
//   turned off or changed like any rule. A carrier that is down never stops another.
//
// Non-negotiable invariants
//   1. Nothing here names a carrier. `route` is the carrier's own name ("Apple Notes", "Email"), given by the caller.
//   2. One item from one place is one message and one arrival: an item that is its own conversation (a carrier names
//      no conversation_id) is kept by its place at the source (route + source_id, src/messages.mjs 3a), so a carrier resending after a lost reply, re-reading the item, or
//      sending it renamed or edited keeps the same message (with its words now) and writes no second arrival, and so
//      sets off no second rule. Every message has at most one arrival, whichever road kept it.
//   2a. The arrival names the item's decision (`case_id`, for words from the person) and how deep in a chain of work
//      it sits (`depth`: 0 for what a person or someone else sent, one more for each piece of work an AI left to do
//      next, src/work-results.mjs), so the AI works it through its decision and a chain of follow-ups stays bounded.
//      A carrier that knows its place has no chat says so (`chat_first_minutes`, src/work-sources.json); an item that
//      names no conversation (a note, a memo, an email) is its own conversation, so it waits for no chat (0).
//   2b. Words the person's attention rules keep as context (src/attention.mjs: chatter a carrier heard in a room) are
//      kept as a message like any other and write no arrival, so no decision, job, judge or model follows them.
//   3. Words from someone the person has not listed are handed on as information, never as instructions
//      (`from_person: false`), so a stranger's email cannot direct the person's AIs.
//   4. The words are kept exactly; only the arrival's job line is cut to fit, and it says where the rest is.
//   5. The arrival carries `job` for the AI and `said` for the person: the words written, with who sent them when it
//      was someone else. Every screen shows `said`; the job, with its tool names and ids, is never shown to the person.
//   3a. A heard request someone else made is theirs (src/attention.mjs keptAs sets `words_as` and `person_record`
//      after the door, never a carrier): the speaker is a person record (`record:person:<id>`, `speakerRecord`), so a
//      voice nobody has named owns its requests until it is named (nameHeardSpeaker files the record under the name, as
//      messages.mjs nameSpeaker files its words), and any list of people (row_type person) shows it.
//   6. A file that came with a message is part of that message's item (`item-of:<file identity>` names the message),
//      so work about the file later (a recording's transcript, src/voice-memos.mjs) joins the message's one job
//      instead of making a second one for the same input.
//   7. A carrier that brings many items at once (every turn of one moment heard in a room) sends them in one request,
//      { items } (src/person-store.mjs takeArrival): each is taken exactly as if sent alone and answered in order, so
//      a moment costs one request whatever it holds.
//   8. Words a carrier heard (`heard: true`) that are mostly words Trillion itself said out loud to this person recently
//      (src/heard-echo.mjs, numbers in src/heard-echo.json: the notices that reach a speaking channel, the fixed ask line,
//      the lines said after a spoken answer) are Trillion's own voice coming back through a microphone, in the
//      person's cloned voice that speaker identification cannot tell from theirs. They are kept, never lost, under the
//      speaker the data names ("generated context") with evidence naming the notice they echo, as context: no
//      arrival, so no decision or job follows. Both roads ask (take and receiveMoment, through prepared); the
//      notices come from the owner (`spoken`), so this file names no channel, kind or carrier. Two rules ask (word
//      runs, and content words found in one notice; the evidence says which). A heard turn that comes with
//      `spoke: { notice_id }` was heard while the Mac was speaking (its own record of when it spoke, computer/listen.mjs):
//      it is kept the same way, as generated context with evidence naming the notice id, and its words are not weighed.
//
// Security
//   One store per person. The caller is the person's own signed-in carrier or Trillion's own mail handler; whether a
//   sender is the person is decided by the caller that can see the sender, and passed as from_person.
//
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import inboundWords from './inbound-words.json' with { type: 'json' };
import doorFields from './inbound-fields.json' with { type: 'json' };
import { MAX_BATCH as MESSAGE_BATCH_LIMIT } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { canonicalApp, harnessFor } from '../../set-up-my-account/read-data/harnesses.mjs';
import { isHybridTimestamp, receiveHybridClock, tickHybridClock } from '../../keep-and-wake-ai-sessions-on-this-computer/src/hybrid-clock.mjs';
import { resolveKeptMessage } from '../../keep-and-wake-ai-sessions-on-this-computer/src/entity-mentions.mjs';
import { quoteUntrusted } from '../../quote-untrusted-words/read-data/untrusted-text.mjs';

// The road a message came in by, kept on it as captured_road (src/messages.mjs record); saved-logins.json lists which roads count as verified.
const CARRIER_DOOR = 'carrier_door';
const MAX_JOB = 8000;
// The longest `said` an arrival keeps: the handoff it becomes keeps no more (src/agents.mjs).
const SAID_MAX = 300;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

export class InboundError extends Error {}

// What a carrier sent to the door, checked once as it arrives (inbound-fields.json): an object; each named field holds
// its kind of value or the whole arrival is refused, naming every wrong field at once; a field nobody reads is left out
// and named back in ignored_fields. Anything else (bytes that are not an object, null, a list) is refused in words.
const isKind = {
  text: value => typeof value === 'string',
  boolean: value => typeof value === 'boolean',
  number: value => typeof value === 'number' && Number.isFinite(value),
  list: value => Array.isArray(value),
  object: value => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
};
export function arrivalAtTheDoor(sent) {
  if (!isKind.object(sent)) throw new InboundError('Send one arrival as an object: { route, source_id, text, at, ... }.');
  const arrival = {};
  const ignored = [];
  const problems = [];
  for (const [field, value] of Object.entries(sent)) {
    const kind = Object.hasOwn(doorFields.fields, field) ? doorFields.fields[field] : null;
    if (!kind) { ignored.push(field); continue; }
    if (value === undefined || value === null) continue;
    if (!isKind[kind](value)) { problems.push(`${field} must be ${doorFields.kinds[kind].said}`); continue; }
    const nested = doorFields.nested_fields?.[field];
    if (nested && field === 'files') {
      const files = value.map((file, index) => {
        const at = `files[${index}]`;
        if (!isKind.object(file)) { problems.push(`${at} must be an object`); return null; }
        const clean = {};
        for (const [name, part] of Object.entries(file)) {
          if (!Object.hasOwn(nested.item, name)) { problems.push(`${at}.${name} is not a field this door reads`); continue; }
          const partKind = nested.item[name];
          if (part === undefined || part === null) continue;
          if (!isKind[partKind](part)) { problems.push(`${at}.${name} must be ${doorFields.kinds[partKind].said}`); continue; }
          clean[name] = part;
        }
        for (const name of nested.required ?? []) if (!nonempty(clean[name])) problems.push(`${at}.${name} is required`);
        return clean;
      });
      arrival[field] = files;
      continue;
    }
    if (nested && (field === 'voice' || field === 'spoke')) {
      const clean = {};
      for (const [name, part] of Object.entries(value)) {
        if (!Object.hasOwn(nested, name)) { problems.push(`${field}.${name} is not a field this door reads`); continue; }
        const partKind = nested[name];
        if (part === undefined || part === null) continue;
        if (!isKind[partKind](part)) { problems.push(`${field}.${name} must be ${doorFields.kinds[partKind].said}`); continue; }
        clean[name] = part;
      }
      arrival[field] = clean;
      continue;
    }
    arrival[field] = value;
  }
  if (arrival.clock !== undefined && !isHybridTimestamp(arrival.clock)) problems.push('clock must be an object containing non-negative wall_ms and logical values plus a device_id');
  if (problems.length) throw new InboundError(problems.join('; '));
  return { arrival, ignored_fields: ignored };
}

const ARRIVAL = 'arrival';
const ITEM_OF = 'item-of';
const PERSON = 'record:person';
const HLC_STATE = 'setting:hybrid-clock-state';
const keyOf = parts => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(parts))).slice(3).slice(0, 24);

/**
 * The person record a heard speaker is kept as: an enrolled speaker by their name, a voice nobody has named by the
 * place it was heard and the label it was heard under ("Someone (voice-3)" in Listening), the label messages keep.
 */
export const speakerRecord = ({ route, from, named }) => `${PERSON}:heard-${named ? keyOf(['name', from]) : keyOf(['voice', route, from])}`;

/** A voice named afterward: its person record carries the name, and the named person's record knows the voice. When the
 *  person chose a row they already keep (`same_as`, a `record:<row type>:<id>` from their lists), the voice is linked to
 *  that row, and that row learns the voice; otherwise to the person record made from the name. */
export function nameHeardSpeaker(eeaf, { app, speaker, name, same_as: chosen, expected_name, remove = false, naming_window, at = new Date().toISOString() }) {
  const id = speakerRecord({ route: app, from: speaker });
  const voice = eeaf.read(id);
  if (!voice) return null;
  const windowOrder = key => {
    try { const value = JSON.parse(key); return Array.isArray(value) && typeof value[2] === 'string' ? Date.parse(value[2]) : NaN; }
    catch { return NaN; }
  };
  if (naming_window && voice.naming_window && voice.naming_window !== naming_window
    && windowOrder(voice.naming_window) > windowOrder(naming_window))
    return { voice: id, person: voice.same_as ?? null, skipped_older_session: true };
  const sameWindowAssociation = !naming_window || !voice.naming_window || voice.naming_window === naming_window;
  if ((expected_name !== undefined && (!nonempty(expected_name) || (sameWindowAssociation && (voice.name !== expected_name || voice.named_from !== speaker)))) || (remove && !nonempty(expected_name)))
    throw new Error('This voice changed after the name on the card. Reopen the current voice before correcting it.');
  if (remove) {
    const expectedGenerated = speakerRecord({ from: voice.name, named: true });
    const candidate = voice.same_as === expectedGenerated ? eeaf.read(voice.same_as) : null;
    const priorGenerated = candidate?._generated_voice_link === true && voice.same_as_is_generated !== false ? candidate : null;
    const { named_from, named_at, same_as, same_as_is_generated, ...rest } = voice;
    eeaf.write([
      { id, type: PERSON, value: { ...rest, name: speaker } },
      ...(priorGenerated ? [{ id: voice.same_as, type: PERSON,
        value: { ...priorGenerated, heard_as: (priorGenerated.heard_as ?? []).filter(value => value !== `${app}: ${speaker}`) } }] : []),
    ], { actor: { by: 'speaker-naming-removal', app } });
    return { voice: id, removed: true };
  }
  const picked = typeof chosen === 'string' && /^record:[^:]+:.+/.test(chosen) ? chosen : null;
  const named = picked ?? speakerRecord({ from: name, named: true });
  if (voice.named_from === speaker && voice.name === name && voice.same_as === named) {
    if ((naming_window && voice.naming_window !== naming_window) || (picked && voice.same_as_is_generated !== false))
      eeaf.write([{ id, type: PERSON, value: { ...voice,
        ...(naming_window ? { naming_window } : {}), ...(picked ? { same_as_is_generated: false } : {}) } }], { actor: { by: 'speaker-naming', app } });
    return { voice: id, person: named, unchanged: true };
  }
  if (voice.named_from === speaker && voice.name === name && voice.same_as !== named)
    throw new Error('This voice is already linked to a different person. Reopen the current voice before retrying the name.');
  const person = eeaf.read(named);
  // A chosen row is theirs: it is linked, never rewritten (its fields are the person's); only a record made here learns the voice.
  const priorHeardAs = `${app}: ${speaker}`;
  const expectedGenerated = speakerRecord({ from: voice.name, named: true });
  const candidate = expected_name && voice.same_as === expectedGenerated ? eeaf.read(voice.same_as) : null;
  const priorGenerated = candidate?._generated_voice_link === true && voice.same_as_is_generated !== false ? candidate : null;
  const generatedTarget = !picked && (!person || person._generated_voice_link === true);
  eeaf.write([
    { id, type: PERSON, value: { ...voice, name, named_from: speaker, named_at: at, same_as: named, same_as_is_generated: generatedTarget, ...(naming_window ? { naming_window } : {}) } },
    ...(priorGenerated && voice.same_as !== named ? [{ id: voice.same_as, type: PERSON,
      value: { ...priorGenerated, heard_as: (priorGenerated.heard_as ?? []).filter(value => value !== priorHeardAs) } }] : []),
    ...(generatedTarget ? [{ id: named, type: PERSON, value: { ...(person ?? { name, first_heard_at: voice.first_heard_at }), _generated_voice_link: true, heard_as: [...new Set([...(person?.heard_as ?? []), priorHeardAs])] } }] : []),
  ], { actor: { by: 'speaker-naming', app } });
  return { voice: id, person: named };
}

/** The record naming the item a file is part of (the message it came with), read by id: `item-of:<file identity>`. */
export const itemOfFile = identity => `${ITEM_OF}:${identity}`;

// kept: messages(...) from messages.mjs. eeaf: the person's records ({ write, read }), the writes the trigger engine
// watches. arrivalsOf(message_id) → the ids of the arrivals already kept for that message (the store's field read).
// caseOf(message_id) → the decision a person's message belongs to (src/message-decision.mjs placeMessage): a follow-up
// is worked through the decision it continues.
// spoken() → the notices Trillion told this person (src/tell-the-person.mjs, with `at` and `results`), read only when a
// heard turn is weighed (invariant 8).
export function inbound({ kept, eeaf, arrivalsOf, caseOf, itemOfArrival, textKeyOf, echoOf, heardEcho, recorder = {}, spoken = () => [], moments = { place: () => ({}) }, onResolved = () => {}, step = (label, work) => work() }) {
  // These owners remain the account's admitted decision/moment services. Refuse
  // before recording an arrival if they were not supplied; an inferred case id,
  // a no-op moments service or treating an unchecked microphone as a person would
  // silently lose the original safety and continuity guarantees.
  for (const [name, service] of Object.entries({ caseOf, itemOfArrival, textKeyOf }))
    if (typeof service !== 'function') throw Object.assign(new InboundError(`The admitted ${name} owner is unavailable.`), { status: 503 });
  // Each kept message linked to what it names (src/entity-mentions.mjs), then told to `onResolved` (the person store
  // weighs whether the person says a named row is already done, src/said-done.mjs).
  // Each part runs as a named `step` (the store's meter), so what one costs is seen apart from the rest.
  const resolve = message_id => { const resolution = step('receive:mentions', () => resolveKeptMessage(eeaf, message_id)); step('receive:said-done', () => onResolved(message_id)); return resolution; };
  function keepArrival(arrival, message_id) {
    const arrival_id = `${ARRIVAL}:${makeHashCodeHexFromBytes(new TextEncoder().encode(message_id)).slice(3).slice(0, 24)}`;
    const earlier = eeaf.read(arrival_id) ? arrival_id : arrivalsOf(message_id)[0];
    const resolved = eeaf.read(message_id)?.entity_resolution;
    const fromPerson = arrival.from_person !== false;
    // Whose words these are picks the words the AI and the person are given (inbound-words.json): the person's own,
    // someone else's, or work an AI left to do next.
    // A heard request kept as someone else's names its own words (src/attention.mjs keptAs words_as, set after the door).
    const voice = nonempty(arrival.follows) ? 'follow_up'
      : nonempty(arrival.words_as) && Object.hasOwn(inboundWords, `job_${arrival.words_as}`) ? arrival.words_as
        : fromPerson ? 'from_person' : 'from_someone_else';
    const case_id = fromPerson ? caseOf(message_id) : null;
    // A speaker who asked for something is a person of their own (invariant 3a): kept once, the first time.
    const named = arrival.voice?.named === true && nonempty(arrival.voice?.name);
    const speaker = !fromPerson && arrival.person_record === true && nonempty(arrival.from) ? speakerRecord({ route: arrival.route, from: arrival.from, named }) : null;
    const newPerson = speaker && !eeaf.read(speaker)
      ? [{ id: speaker, type: PERSON, value: { name: arrival.from, first_heard_at: arrival.at, heard_as: [`${arrival.route}: ${arrival.from}`], ...(named ? {} : { voice: arrival.voice?.voice ?? arrival.from }) } }]
      : [];
    // Another party's words, sender and title reach the AI's job only through the one quote (src/untrusted-text.mjs);
    // the kept message keeps them exactly as they came.
    const quoted = fromPerson || voice === 'follow_up' ? value => value : value => quoteUntrusted(value, { max: MAX_JOB });
    const lead = fill(inboundWords[`job_${voice}`], {
      person: inboundWords.person, route: arrival.route, from: quoted(arrival.from ?? ''), message_id, case_id: case_id ?? '', follows: arrival.follows ?? '',
      titled: nonempty(arrival.title) ? fill(inboundWords.titled, { title: quoted(arrival.title) }) : '',
      speaker: speaker ? fill(named ? inboundWords.speaker_named : inboundWords.speaker_unnamed, { speaker_record: speaker, from: arrival.from, route: arrival.route }) : '',
    });
    const files = arrival.files?.length ? `\n\n${fill(inboundWords.files, { files: arrival.files.map(file => file.name ?? file.id).join(', ') })}` : '';
    // Clipped words always end with where the rest is: the kept message, and the files that came with it, which can
    // hold more than the kept message does (a long text goes whole as a file beside it).
    const tail = `\n\n${fill(inboundWords.rest_in_messages, { message_id })}${arrival.files?.length ? ` ${inboundWords.rest_in_files}` : ''}`;
    const room = MAX_JOB - lead.length - files.length - 2;
    const jobText = resolved?.text ?? arrival.text;
    const shownText = quoted(jobText);
    const body = shownText.length <= room ? shownText : shownText.slice(0, room - tail.length) + tail;
    // What the person sees of this work (their notifications, AI work): their own words, never the job for the AI.
    const words = arrival.text.trim() ? arrival.text.trim().replace(/\s+/g, ' ') : '';
    const said = fill(words ? inboundWords[`said_${voice}`] : inboundWords[`said_${voice}_files`],
      { text: words, route: arrival.route, from: nonempty(arrival.from) ? arrival.from : inboundWords.someone }).slice(0, SAID_MAX);
    // Each file that came with the message is part of the message's item (invariant 6): the first message a file came
    // with stays its item.
    const parts = (arrival.files ?? []).filter(file => !eeaf.read(itemOfFile(file.id)))
      .map(file => ({ id: itemOfFile(file.id), type: ITEM_OF, value: { file: file.id, item: message_id } }));
    const job = `${lead}${files}\n\n${body}`;
    const projection = { job, said, ...(resolved ? { resolved_text: jobText, entities: resolved.mentions } : {}) };
    if (earlier) {
      const before = eeaf.read(earlier);
      const next = { ...before, ...projection };
      if (!resolved) { delete next.resolved_text; delete next.entities; }
      if (before && JSON.stringify(next) !== JSON.stringify(before))
        eeaf.write([{ id: earlier, type: ARRIVAL, value: next }], { actor: { by: 'carrier-edit', app: arrival.route }, unwatched: true });
      return { message_id, arrival_id: earlier, repeated: true };
    }
    const previousClock = eeaf.read(HLC_STATE)?.clock ?? null;
    const eventClock = arrival.clock ?? tickHybridClock(previousClock, Date.now(), 'trillion');
    const clockState = receiveHybridClock(previousClock, eventClock, Date.now(), 'trillion');
    // The moment step (src/moments.mjs): what arrives close together is one job. `moment` holds this arrival back for
    // the moment it joined; `once_per` makes the same words sent to another AI part of the first one's job.
    const text_key = fromPerson && !speaker ? textKeyOf(arrival.text) : '';
    const placed = moments.place(itemOfArrival(arrival_id, { ...projection, route: arrival.route, source_id: arrival.source_id, at: arrival.at, message_id, from_person: fromPerson, files: arrival.files, title: arrival.title, priority: inboundWords.priority[voice] ?? 0, case_id, follows: arrival.follows, chat_first_minutes: arrival.chat_first_minutes, text_key }));
    eeaf.write([...parts, ...newPerson, { id: arrival_id, type: ARRIVAL, value: {
      ...projection, ...(placed.job ? { job: placed.job } : {}), ...(placed.moment ? { moment: placed.moment } : {}), ...(placed.once_per ? { once_per: placed.once_per } : {}), route: arrival.route, source_id: arrival.source_id, at: arrival.at, message_id, from_person: fromPerson,
      clock: eventClock,
      priority: inboundWords.priority[voice] ?? 0,
      depth: Number.isInteger(arrival.depth) && arrival.depth > 0 ? arrival.depth : 0,
      ...(case_id ? { case_id } : {}),
      ...(nonempty(arrival.follows) ? { follows: arrival.follows } : {}),
      ...(Number.isFinite(arrival.chat_first_minutes) && arrival.chat_first_minutes >= 0 ? { chat_first_minutes: arrival.chat_first_minutes } : {}),
      ...(nonempty(arrival.title) ? { title: arrival.title } : {}),
      ...(nonempty(arrival.from) ? { from: arrival.from } : {}),
      ...(speaker ? { speaker_record: speaker } : {}),
      ...(arrival.files?.length ? { files: arrival.files.map(({ id, name }) => ({ id, ...(nonempty(name) ? { name } : {}) })) } : {}),
    } }, { id: HLC_STATE, type: 'setting', value: { clock: clockState } }], { actor: { by: 'carrier', app: arrival.route } });
    return { message_id, arrival_id, repeated: false };
  }
  return {
    prepare: arrival => prepared(arrival),
    // Interpretation reuses the existing source message; it never records a second transcript.
    receiveCaptured(arrival, message_id, { context = false } = {}) {
      const checked = prepared(arrival);
      const message = eeaf.read(message_id);
      if (!message || message.app !== checked.message.app || message.text !== checked.message.text || message.conversation_id !== checked.message.conversation_id
        || (checked.message.source_ref !== undefined && message.source_ref !== checked.message.source_ref))
        throw new InboundError('The captured input changed before its arrival could commit.');
      resolve(message_id);
      if (checked.echo) return { message_id, attention: 'context', echo: checked.echo };
      if (context) return { message_id, attention: 'context' };
      return keepArrival({ ...checked.arrival, clock: checked.arrival.clock ?? message.clock }, message_id);
    },
    // A chat message already stored through /messages follows the same arrival road as every other carrier.
    receiveKept(message_id) {
      const message = eeaf.read(message_id);
      if (!message || message.speaker !== 'person') throw new InboundError('A kept message from the person is required.');
      resolve(message_id);
      // An app whose row says it takes no work from the queue (src/harnesses.json) has no chat to wait for.
      return keepArrival({ route: message.app, source_id: message.conversation_id, text: message.text, at: message.at,
        ...(harnessFor(message.app).takes_work === false ? { chat_first_minutes: 0 } : {}),
        files: [...new Set([...(message.attachments ?? []).map(file => typeof file === 'string' ? file : file.identity), ...(message.about ?? []).filter(link => link.kind === 'file').map(link => link.id)])].map(id => ({ id })),
      }, message_id);
    },
    // What a carrier brings: { route, source_id, text, at, title?, from?, from_person?, files?, chat_first_minutes? }
    //   -> { message_id, arrival_id, repeated }. Only Trillion itself says an arrival follows earlier work.
    // `context` (src/attention.mjs decided the words call for no AI) keeps the message and writes no arrival, so no rule
    // hands it to anyone: -> { message_id, attention: 'context' }.
    receive(arrival = {}, { context = false } = {}) { return take({ ...arrival, follows: undefined, depth: undefined }, { context }); },
    // Work an AI left to do next (src/work-results.mjs): { ...as receive, follows (the handoff it came from), depth }.
    followUp(arrival) { return take(arrival); },
    // One moment a carrier heard: keep its messages in bounded writes using the message owner's limit, rather than
    // one write per sentence; each turn that is not context then keeps its
    // arrival as receive does. contexts[i] says turn i is context. -> [{ message_id, arrival_id?, attention? } | { error }].
    receiveMoment(arrivals = [], contexts = []) {
      // A turn missing what every arrival needs answers { error } in its place; the others are kept together.
      const ready = arrivals.map(arrival => { try { return prepared({ ...arrival, follows: undefined, depth: undefined }, false); } catch (error) { return { error: error.message }; } });
      const implicit = ready.filter(item => !item.error && !nonempty(item.arrival.conversation_id));
      for (let start = 0; start < implicit.length; start += MESSAGE_BATCH_LIMIT) {
        const batch = implicit.slice(start, start + MESSAGE_BATCH_LIMIT);
        const conversations = kept.implicitConversations(batch.map(({ arrival }) => ({ route: arrival.route, source_id: arrival.source_id,
          source_ref: nonempty(arrival.source_ref) ? arrival.source_ref : arrival.source_id })), { per_source: true });
        for (const [index, item] of batch.entries()) {
          if (conversations[index] instanceof Error) item.error = conversations[index].message;
          else item.message.conversation_id = conversations[index];
        }
      }
      const good = ready.filter(item => !item.error);
      const ids = [];
      for (let start = 0; start < good.length; start += MESSAGE_BATCH_LIMIT) {
        ids.push(...step('receive:keep', () => kept.record({ messages: good.slice(start, start + MESSAGE_BATCH_LIMIT).map(item => item.message) }, { ...recorder, road: CARRIER_DOOR }).ids));
      }
      const idOf = new Map(good.map((item, at) => [item, ids[at]]));
      for (const id of ids) resolve(id);
      return ready.map((item, index) => (item.error ? { error: item.error }
        : item.echo ? { message_id: idOf.get(item), attention: 'context', echo: item.echo }
          : contexts[index] ? { message_id: idOf.get(item), attention: 'context' }
          : keepArrival({ ...item.arrival, clock: item.arrival.clock ?? eeaf.read(idOf.get(item))?.clock }, idOf.get(item))));
    },
  };
  function take(arrival, { context = false } = {}) {
    const { arrival: checked, message, echo } = step('receive:prepare', () => prepared(arrival));
    const message_id = step('receive:keep', () => kept.record({ messages: [message] }, { ...recorder, road: CARRIER_DOOR }).ids[0]);
    resolve(message_id);
    if (echo) return { message_id, attention: 'context', echo };
    if (context) return { message_id, attention: 'context' };
    return step('receive:arrival', () => keepArrival({ ...checked, clock: checked.clock ?? eeaf.read(message_id)?.clock }, message_id));
  }
  // An arrival checked and completed, and the message it is kept as.
  function prepared(arrival, resolveConversation = true) {
    if (arrival.heard === true && (typeof echoOf !== 'function' || !heardEcho))
      throw Object.assign(new InboundError('The account heard-echo rows and checker are unavailable.'), { status: 503 });
    const problems = [];
    for (const field of ['route', 'source_id']) if (!nonempty(arrival[field])) problems.push(`${field} is required`);
    // The time it was written, from the place itself (a note's last change, an email's date), so a resend is the same message.
    if (!nonempty(arrival.at) || Number.isNaN(Date.parse(arrival.at))) problems.push('at is required: when it was written, as the place itself says, like 2026-09-27T17:13:00Z');
    if (!nonempty(arrival.text) && !arrival.files?.length) problems.push('text is required: what was written, exactly, or at least one attached file');
    if (arrival.clock !== undefined && !isHybridTimestamp(arrival.clock)) problems.push('clock must contain a non-negative wall_ms and logical count, plus a device_id');
    if (arrival.files !== undefined && (!Array.isArray(arrival.files) || arrival.files.some(file => !nonempty(file?.id)))) problems.push('files, when given, is a list of { id, name? } of files already kept');
    if (problems.length) throw new InboundError(problems.join('; '));
    arrival = { ...arrival, at: new Date(arrival.at).toISOString() };
    // Heard words that are Trillion's own spoken words coming back are kept as generated context with the evidence (invariant 8).
    const echo = arrival.heard !== true ? null
      : nonempty(arrival.spoke?.notice_id) ? { rule: 'window', share: 1, source: fill(heardEcho.sources.spoken_window, { notice_id: arrival.spoke.notice_id }), evidence: fill(heardEcho.window_evidence, { notice_id: arrival.spoke.notice_id }) }
      : nonempty(arrival.text) ? echoOf(arrival.text, Date.parse(arrival.at), spoken()) : null;
    if (echo) arrival = { ...arrival, from_person: false, from: heardEcho.speaker };
    const fromPerson = arrival.from_person !== false;
    const speaker = fromPerson ? 'person' : (nonempty(arrival.from) ? arrival.from : 'someone not listed');
    // A carrier that names no conversation sends one item that is its own conversation (a note, a memo), named by
    // its source_id, so the same item read again, renamed or edited is the same message. A chat names its
    // conversation, and each of its turns is a message of its own.
    const ownConversation = !nonempty(arrival.conversation_id);
    const app = canonicalApp(arrival.route);
    const conversation = !ownConversation ? arrival.conversation_id : resolveConversation
      ? kept.implicitConversation({ route: arrival.route, source_id: arrival.source_id,
        source_ref: nonempty(arrival.source_ref) ? arrival.source_ref : arrival.source_id })
      : `${app}:${arrival.source_id}`;
    // An item that is its own conversation has no chat that could take its work back, so it waits for none.
    if (ownConversation && arrival.chat_first_minutes === undefined) arrival = { ...arrival, chat_first_minutes: 0 };
    return { arrival, ...(echo ? { echo: { rule: echo.rule, share: echo.share, source: echo.source, evidence: echo.evidence, ...(echo.notice ? { notice: echo.notice } : {}) } } : {}), message: {
      conversation_id: conversation,
      app, speaker, text: arrival.text, at: arrival.at, ...(arrival.clock ? { clock: arrival.clock } : {}),
      ...(fromPerson && nonempty(arrival.origin) ? { origin: arrival.origin } : {}),
      ...(echo ? { evidence: echo.evidence } : {}),
      ...(nonempty(arrival.source_ref) ? { source_ref: arrival.source_ref } : ownConversation ? { source_ref: arrival.source_id } : {}),
      ...(arrival.files?.length ? { attachments: arrival.files.map(file => ({ identity: file.id, ...(nonempty(file.name) ? { name: file.name } : {}), ...(nonempty(file.media_type) ? { media_type: file.media_type } : {}) })) } : {}),
      ...(arrival.files?.length ? { about: arrival.files.map(file => ({ kind: 'file', id: file.id })) } : {}),
    } };
  }
}
