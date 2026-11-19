// tools/hold-one-thing-until-done/read-data/hold-answer.mjs
//
// PURPOSE
//   The hold's read, worked out from what the request carries and nothing else: the waiting answer (`things`, or the
//   person's must-do rows), the hold setting (`state`), the hold rules, the cover and the held thing last kept. It
//   reads and keeps nothing. What it makes comes back in the answer for the caller to keep: the tasks the doer gate and
//   the walk-away nudge hand off (`jobs`, calendar-task records), the held fact (`held_fact`, { key, title } or null) and the
//   device tool runs a change of the held thing starts (`device_runs`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are read-data/needs-you-hold.mjs's, read-data/waiting-weigh.mjs's and read-data/waiting-nudge.mjs's,
//      as old trillion called them; nothing is decided here that they do not.
//   2. A job is one record under a stable id from its source and once_per, so the same trigger is the same record
//      however often it is answered; the caller keeps each record once.
//   3. Nothing is read from or written to the person's rows, and no tool is run: a run to start is an entry of `device_runs`.
import ROWS from './hold-rows.json' with { type: 'json' };
import WAITING from './waiting-on-you.json' with { type: 'json' };
import { heldInput, holdView, withoutHanded } from './needs-you-hold.mjs';
import { makeWaitingNudge } from './waiting-nudge.mjs';
import { inOrder, sameOnce, weighCards } from './waiting-weigh.mjs';
import { whoDoesEachStep } from '../../who-does-each-step/read-data/who-does.mjs';
import WHO from '../../shared-code/src/who-does-it.json' with { type: 'json' };
import { waitingSentence } from '../../what-is-waiting-on-me/read-data/waiting.mjs';
import { prepareProducedTask } from '../../plan-tasks-and-todo-lists/task-moves.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const opensScreenOf = prefixes => (Array.isArray(prefixes) ? address => prefixes.some(prefix => address.startsWith(prefix)) : undefined);

// The doer gate (old src/who-does-it.mjs over src/who-does-it.json): who does each waiting thing.
const weigh = input => whoDoesEachStep({ ...WHO, ...input });
// The Waiting on you DATA under the person's own hold rules (old src/waiting-on-you.json, its `hold` the person's row).
const settingsOf = (rules, things) => ({ ...WAITING, ...(things?.finishes ? { finishes: things.finishes } : {}), hold: { ...WAITING.hold, ...rules } });

const isDone = (value, kind) => kind.done_values.includes(value?.[kind.done_field]);

/** The person's must-do rows as the hold's answer: one section holding a card per row not done yet. */
export function answerOfRows(records, section = {}) {
  const kind = ROWS.must_do;
  const cards = records.filter(record => object(record?.value) && !isDone(record.value, kind)).map(record => ({
    id: record.id,
    // A row names another it waits on by the other's row id; the hold reads `${source}:${name}` as that row's record id.
    source: kind.type,
    ...Object.fromEntries(Object.entries(kind.card).flatMap(([field, from]) => (record.value[from] === undefined ? [] : [[field, record.value[from]]]))),
  }));
  return { sections: [{ ...section, id: section.id ?? kind.section, total: cards.length, cards }] };
}

/** The tasks to keep, prepared through the task owner with the real trigger and no invented sender. */
export function holdJobRecords(jobs, now) {
  const records = new Map();
  for (const job of jobs) {
    if (!job.job?.trim()) continue;
    if (typeof job.once_per !== 'string' || !job.once_per) throw new Error('A hold task needs its stable once_per source.');
    const source = { kind: 'record', ref: job.input?.card_id ?? ROWS.state.id };
    const record = prepareProducedTask({ key: `hold-${makeHashCodeHexFromJson({ source, source_job: job.once_per })}`, description: job.job,
      source, source_task: job.once_per, ...(object(job.input) ? { input: job.input } : {}),
      ...(job.said ? { title: job.said } : {}) }, new Date(now));
    if (!records.has(record.id)) records.set(record.id, record);
  }
  return [...records.values()];
}

/** The waiting answer: the cards the caller hands in, each section's cards kept once and weighed by the doer gate. */
function waitingAnswer(things, settings, input, handOffs) {
  if (!object(things) || !Array.isArray(things.sections)) throw new Error('things must be { sections: [{ id, cards: [...] }] }.');
  const opensScreen = opensScreenOf(input.opens_screens);
  const decided = weighCards(things.sections.map(section => ({ section, cards: sameOnce(section.cards ?? []) })), {
    settings: things.finishes ? { ...settings, finishes: things.finishes } : settings, weigh, given: input.given ?? {}, ...(opensScreen ? { opensScreen } : {}),
  });
  const answer = { ...things, toAis: [...(things.toAis ?? []), ...decided.toAis], sections: decided.rows.map(row => ({ ...row.section,
    total: row.cards.length === row.section.cards?.length ? row.section.total ?? row.cards.length : row.cards.length, cards: row.cards })) };
  for (const item of inOrder(answer.toAis)) if (item.handOff) handOffs.push(item.handOff);
  const cards = answer.sections.flatMap(section => section.cards);
  return { ...answer, cards, count: cards.length,
    ...(answer.sources ? { said: waitingSentence(cards.length, answer.sources) } : {}) };
}

/** The read: the view, what it says, the words, and what the caller keeps (`jobs`, `held_fact`, `device_runs`). */
export async function holdAnswer(input, { rules, state, now }) {
  const things = input.things !== undefined ? input.things
    : Array.isArray(input.must_do) ? answerOfRows(input.must_do)
      : (() => { throw new Error('Send the waiting rows: things ({ sections: [...] }) or must_do (the person\'s Waiting on you rows).'); })();
  const handOffs = [];
  const waiting = settingsOf(rules, things);
  const answer = waitingAnswer(things, waiting, input, handOffs);
  if (answer.finishes) waiting.finishes = answer.finishes;
  const opensScreen = opensScreenOf(input.opens_screens);
  // The walk-away nudge's prepareForHold (old src/waiting-nudge.mjs): what waited long enough and Trillion can do is
  // handed to the AIs, once per card, and the hold is weighed over the rest.
  const nudge = makeWaitingNudge({ read: async () => answer, tell: async () => null, weigh, handOff: async job => { handOffs.push(job); },
    kept: { read: () => null, write: () => {} }, alongside: async () => null, settings: waiting, now: () => now, ...(opensScreen ? { opensScreen } : {}) });
  const prepared = await nudge.prepareForHold(answer, rules.after_minutes);
  let view = holdView(withoutHanded(answer, prepared.handed), state, rules, now, { opensScreen });
  if (input.covered) view = { ...view, held: null, ranked: [] };
  const waitingSources = input.things !== undefined ? { from: 'caller', complete: input.things.complete === true } : { from: 'caller-rows', complete: false };
  const said = view.held ? fill(rules.words?.held, { title: view.held.card.title ?? '' })
    : view.on ? answer.complete === false ? answer.said : rules.words?.free : fill(rules.words?.off, view);
  // An incomplete empty read cannot prove that the held thing or its device lock is free.
  const keepsHeld = Boolean(view.held) || view.on === false || waitingSources.complete === true;
  const heldFact = view.held ? { key: view.held.key, title: view.held.card.title ?? '' } : null;
  const before = input.kept_held ?? null;
  const moved = keepsHeld && ((before?.key ?? null) !== (heldFact?.key ?? null) || (before?.title ?? null) !== (heldFact?.title ?? null));
  const runs = !moved ? [] : heldFact ? rules.devices?.when_held ?? [] : before ? rules.devices?.when_free ?? [] : [];
  return {
    hold: { ...view, said, words: rules.words, waiting_sources: waitingSources },
    jobs: holdJobRecords(handOffs, now),
    ...(keepsHeld ? { held_fact: heldFact } : {}),
    device_runs: runs.map(run => ({ tool_id: run.tool_id, input: heldInput(run.input, heldFact) })),
  };
}
