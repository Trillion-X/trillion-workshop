// src/ai-apps-screen.mjs
//
// PURPOSE
//   The facts of AI apps & keys (the catalogue screen tool:ai-apps, records/marketplace-screens.json): every AI app
//   connected to the account and every personal key, with what each reaches, how long it may go unused and how many
//   calls a minute it may make, the account's pursuits an AI can be given, and its Webhooks section. The layout of the
//   screen is DATA; this file computes values (days, counts, ids, the reach controls from the reach DATA). The read that
//   gathers them is src/screen-reads.mjs readAiApps.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The account a read answers for is the account it runs in, never an input.
//   2. A key is described by its name and last four characters only; its value is never read.
//   3. A part that could not be read says so (the webhooks section's note), never an empty list.
import { AI_REACH_CHOICES, AI_REACH_WORDS, choiceOf, reachWords } from '../../src/ai-reach.mjs';
import { SIGN_IN_LIFETIMES, daysWords } from './sign-in-lifetimes.mjs';
import { callsWords } from './sign-in-calls.mjs';
import { dayWords as day } from './screen-day.mjs';
import { webhooksSection } from './webhooks-screen.mjs';

const newestFirst = (a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));

/**
 * What one AI (an app or a personal key, src/ais-of-account.mjs) reaches, as the line on its row and the controls that
 * change it: { line, note, open_label, fields, save_label, ai_id }. An AI whose reach is not known yet only has its note;
 * one with no sign-ins yet has no line at all. `spaces` are the account's pursuits ({ space_id, title }).
 */
export function reachFacts(ai, spaces) {
  const none = { line: null, note: null, open_label: null, fields: null, save_label: null, ai_id: null };
  if (!ai.sign_ins) return none;
  const titleOf = id => spaces.find(space => space.space_id === id)?.title ?? null;
  const reachLine = AI_REACH_WORDS.reads.line.replace('{reach}', ai.differs ? AI_REACH_WORDS.reads.differs : reachWords(ai.reach, titleOf));
  // How long it may go unused before it stops working (src/sign-in-lifetimes.mjs), on the same line.
  const lifetimeLine = Number.isInteger(ai.idle_days) ? `${reachLine} · ${SIGN_IN_LIFETIMES.words.line.replace('{days}', String(ai.idle_days))}` : reachLine;
  // How many calls a minute it may make and made lately (src/sign-in-calls.mjs), on the same line.
  const line = Number.isInteger(ai.calls?.limit) ? `${lifetimeLine} · ${callsWords({ limit: ai.calls.limit }, ai.calls.used)}` : lifetimeLine;
  if (!ai.reach && !ai.differs) return { ...none, line, note: AI_REACH_WORDS.fields.unknown_note };
  const picks = AI_REACH_CHOICES.filter(choice => choice.spaces === 'picked').map(choice => choice.id);
  return {
    ...none, line,
    open_label: AI_REACH_WORDS.fields.open,
    fields: [
      { name: 'reach', label: AI_REACH_WORDS.fields.choice, kind: 'choice', options: AI_REACH_CHOICES.map(choice => ({ value: choice.id, label: choice.label })), value: ai.reach ? choiceOf(ai.reach) : AI_REACH_CHOICES[0].id },
      ...(Number.isInteger(ai.idle_days) ? [{ name: 'lasts', label: SIGN_IN_LIFETIMES.words.field, kind: 'choice', options: SIGN_IN_LIFETIMES.choices_days.map(days => ({ value: String(days), label: daysWords(days) })), value: String(ai.idle_days) }] : []),
      { name: 'spaces', label: AI_REACH_WORDS.fields.spaces, kind: 'pick', add_label: AI_REACH_WORDS.fields.add_space, options: spaces.map(space => ({ value: space.space_id, label: space.title ?? 'A pursuit' })), values: Array.isArray(ai.reach?.spaces) ? ai.reach.spaces : [], shows_when: { name: 'reach', values: picks } },
    ],
    save_label: AI_REACH_WORDS.fields.save, ai_id: ai.ai_id,
  };
}

/**
 * AI apps & keys' facts: { apps, keys, webhooks }. `apps` and `keys` are src/ais-of-account.mjs aisOfAccount's rows, keys
 * newest first; `spaces` the account's pursuits; `hooks` its webhooks (null when they could not be read).
 */
export function aiAppsFacts({ apps, keys, spaces, hooks }) {
  const named = text => (typeof text === 'string' && text ? text : null);
  return {
    apps: apps.map(app => ({
      id: app.id, name: app.name ?? null, grant_ids: app.grant_ids, sign_in_count: app.grant_ids.length,
      connected_day: app.created_at ? day(app.created_at) : null, last_used_day: app.last_used_at ? day(app.last_used_at) : null,
      reach: reachFacts(app, spaces),
    })),
    keys: [...keys].sort(newestFirst).map(key => ({
      id: key.id, name: key.name ?? null, ending: named(key.ending),
      made_day: key.created_at ? day(key.created_at) : null, last_used_day: key.last_used_at ? day(key.last_used_at) : null,
      reach: reachFacts(key, spaces),
    })),
    webhooks_section: webhooksSection(hooks),
  };
}
