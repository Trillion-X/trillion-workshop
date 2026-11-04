// src/queued-work.mjs
//
// Purpose
//   A button in the Trillion app ("Ask my AI to look into this" on a goal, "Ask my AI to introduce us" next to a
//   person) asks the person's own AIs to do a job. Trillion runs no model for it: the press keeps one record holding
//   the job in words, and what happens next is the person's own rules over that record kind (src/automations.mjs, run
//   by the trigger engine). Every account starts with one that hands it to whichever of their AIs takes it first
//   (records/starting-rules.json, starting:asked, through the workflow for purpose hand-to-an-agent); a rule the person sets can hand a
//   job to one AI by its agent_id (the workflow's to_agent), so the person's rules decide which AIs are pinged. The
//   handoff then reaches each AI the way all handed work does: take_work, a notice on its next tool reply
//   (src/handoff-notice.mjs), and a signed event at its delivery address when it gave one (src/agent-delivery.mjs).
//   This is src/inbound.mjs's road for what a person writes elsewhere, used for what a person presses here.
//
// Non-negotiable invariants
//   1. The job words come from src/queued-work.json, one row per job; the press sends only the job's id, the values
//      its row names under `context` (each a short line of text, or empty for a name in `optional_context`) and a
//      press key. A job with no row is refused.
//   2. The same press arrives once: the record is named by the BLAKE3 identity of the job id, its context and the press
//      key, so a browser resending after a lost answer writes nothing and sets off no rule; pressing again is new work.
//   3. Nothing here names a job, a screen or an AI: all of that is the row's, the caller's or the person's rules'.
//   4. The record carries the job in words and the context, never files or secrets.
//   5. The record carries two sets of words: `job`, what the AI is asked, and `said`, the same work as the person sees it
//      (their notifications, AI work). A screen shows `said`, never `job`, so the AI's instructions never reach the person.
//   6. The record carries the person's own priority (src/inbound-words.json priority.from_person): a press, or a
//      recording kept for them, is their own words, so every taker serves it ahead of information that arrived for them
//      and is never held back behind other work (src/own-ais-routing.mjs). Without it a
//      recording waited behind 1937 follow-ups and a quota-spent day on 2026-10-04.
//   7. The record names the item it is about (`item`): its own id, unless Trillion itself names the input it belongs
//      to (a recording that came with a message is part of that message, src/voice-memos.mjs). The rules hand one job
//      per item, so a press about an input that already has a job joins it. A page's press never names an item.
//   8. A press may carry the person's steps just before it (`steps`, parts/ui/show/recent-steps): checked against
//      queued-work.json `steps`, kept with the record and added to the job's words. Never part of the press's identity.
//
// Security
//   One store per person. The caller is the person's own signed-in page (the origin check every /work/api write
//   makes, src/worker.mjs), so the context values are the person's own words about their own records.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from './queued-work.json' with { type: 'json' };
import inboundWords from '../../keep-and-wake-ai-sessions-on-this-computer/src/inbound-words.json' with { type: 'json' };
import { itemOfAsked } from '../../shared-code/src/moments.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// A context value is one line of text: no control characters, so it cannot break the job's words apart.
const oneLine = value => nonempty(value) && !/[\u0000-\u001f\u007f]/.test(value);
const paragraphs = value => nonempty(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');

export class QueuedWorkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** The jobs a button can name, as a screen needs them: { id, label, context }. */
export const queuedJobs = (rules = settings) => rules.jobs.map(({ id, label, context }) => ({ id, label, context }));

// One press read against its job row: { asked_id, job, job_id, label, context }, or a QueuedWorkError naming what is
// wrong. The asked_id is the press's identity (invariant 2); nothing is written.
export function readPress(press = {}, rules = settings) {
  const row = rules.jobs.find(item => item.id === press.job_id);
  if (!row) throw new QueuedWorkError(rules.words.unknown_job, 404);
  const problems = [];
  if (!nonempty(press.press_key) || press.press_key.length > rules.press_key_max) problems.push(`press_key is required: any text up to ${rules.press_key_max} characters, new for each press`);
  const given = object(press.context) ? press.context : {};
  const context = {};
  for (const name of row.context) {
    const value = given[name];
    const max = row.context_max ?? rules.context_max;
    const multiline = row.multiline_context?.includes(name);
    // A name the row lists as optional may be sent empty: it is kept as nothing (the job's words read it so).
    if (row.optional_context?.includes(name) && (value === undefined || value === null || (typeof value === 'string' && !value.trim()))) { context[name] = ''; continue; }
    const valid = multiline ? paragraphs(value) : oneLine(value);
    if (!valid || value.length > max) problems.push(`context.${name} is required: ${multiline ? 'text' : 'one line of text'} up to ${max} characters`);
    else context[name] = value.trim();
  }
  if (problems.length) throw new QueuedWorkError(problems.join('; '));
  const identity = bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([row.id, row.context.map(name => context[name]), press.press_key])))).slice(0, 24);
  const steps = stepsOf(press.steps, rules.steps);
  const job = fill(row.job, { ...context, label: row.label });
  return {
    asked_id: `${rules.record_kind}:${identity}`,
    job: steps.length ? `${job}\n\n${rules.steps.heading}\n${steps.map(step => fill(rules.steps.line, step)).join('\n')}` : job,
    said: fill(row.said, context).trim(), job_id: row.id, label: row.label, context,
    ...(steps.length ? { steps } : {}),
  };
}

// The steps a press sent (parts/ui/show/recent-steps): each { at, kind, label, where } of one line within its max,
// oldest first, at most `max`. A step that is not is left out; the steps never decide whether the press is kept, and
// they are not part of the press's identity, so the same press resent is the same job.
function stepsOf(given, limits) {
  if (!Array.isArray(given)) return [];
  const fits = (value, max) => oneLine(value) && value.length <= max;
  return given
    .filter(step => object(step) && fits(step.at, 40) && !Number.isNaN(Date.parse(step.at)) && fits(step.kind, limits.kind_max) && fits(step.label, limits.label_max) && fits(step.where, limits.where_max))
    .slice(-limits.max)
    .map(({ at, kind, label, where }) => ({ at, kind, label: label.trim(), where }));
}

// eeaf: the person's records ({ write, read }), the writes the trigger engine watches.
// moments: the moment step (src/moments.mjs); a recording asked about close to others (a voice memo, a camera clip) is
// held for their moment and handed off with them, so it carries `moment` and starting:asked leaves it.
export function queuedWork({ eeaf, rules = settings, now = () => new Date(), moments = { place: () => ({}) } }) {
  return {
    // { job_id, context: { name: text }, press_key }, { item? } -> { asked_id, repeated, said }
    queue(press = {}, { item = null } = {}) {
      const { asked_id, ...value } = readPress(press, rules);
      if (eeaf.read(asked_id)) return { asked_id, repeated: true, said: rules.words.done };
      const kept = { ...value, item: nonempty(item) ? item : asked_id, priority: inboundWords.priority.from_person, at: now().toISOString() };
      const { moment = null } = moments.place(itemOfAsked(asked_id, kept));
      eeaf.write([{ id: asked_id, type: rules.record_kind, value: { ...kept, ...(moment ? { moment } : {}) } }], { actor: { by: 'person' } });
      return { asked_id, repeated: false, said: rules.words.done };
    },
  };
}
