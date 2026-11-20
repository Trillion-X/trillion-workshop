// tools/turn-a-finished-decision-into-an-anonymous-public/read-data/story-facts.mjs
//
// What a public story is written from: a finished decision's facts, its latest settled result, the kind it is filed
// under, and the permanent address a story is kept at. Pure: no disk, no clock except the caller's, no model.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a finished decision (something was chosen, from at least one option) yields facts.
//   2. Facts are the decision's own fields. Retracted evidence is never read. The worked answers reach the facts only as
//      the `thinking` rows the caller renders, with no question of the method attached, and the whole is capped at
//      rewrite.facts_limit_characters, dropping thinking first, then context, so the decision itself always fits.
//   3. A story's address is 80 random bits from BLAKE3 as 20 lowercase hex characters. It is derived from fresh random
//      bytes, never from the decision, so the public address does not name the decision it came from.
//   4. A kind not listed in the DATA is filed under the fallback kind (the row marked fallback).
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const settings = JSON.parse(readFileSync(new URL('./story-settings.json', import.meta.url), 'utf8'));
const text = value => String(value ?? '').trim();
const clip = (value, size) => (value.length > size ? `${value.slice(0, size)}…` : value);

/** The id a story is filed under: the listed kind, else the fallback. */
export function kindOf(id, kinds = settings.kinds) {
  const fallback = kinds.find(kind => kind.fallback)?.id ?? kinds.at(-1).id;
  return kinds.some(kind => kind.id === id) ? id : fallback;
}

/** A new story's permanent address: the first 80 bits of the BLAKE3 digest of 32 fresh random bytes, as hex. */
export const mintStoryId = () => bytesToHex(blake3(crypto.getRandomValues(new Uint8Array(32)))).slice(0, 20);
export const isStoryId = value => typeof value === 'string' && /^[0-9a-f]{20}$/.test(value);

/** Whether a decision is finished enough to be a story: something was chosen from its options. */
export const isFinished = record => Boolean(record?.decision && record.input?.options?.length);

/** The latest settled result of a decision: what the owner reported, else what a check observed (not unknown). */
export function latestResult(record) {
  if (!record) return null;
  const reported = (record.reports ?? []).map(report => ({ result: report.result, what_happened: report.summary, at: report.reported_at }));
  const checked = (record.outcome_checks ?? [])
    .filter(check => check.result && check.result !== 'unknown')
    .map(check => ({ result: check.result, what_happened: check.reason, at: check.checked_at }));
  return [...reported, ...checked].sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) ?? null;
}

/**
 * The facts a story is written from. `thinking` is the caller's list of worked-answer sentences (strings), already in
 * plain words. `limit` is the character cap (rewrite.facts_limit_characters by default).
 */
export function storyFacts(record, { thinking = [], limit = settings.rewrite.facts_limit_characters } = {}) {
  const label = id => record.input.options.find(option => option.id === id)?.label ?? id;
  const outcome = latestResult(record);
  const facts = {
    goal: text(record.input.goal),
    context: (record.input.evidence ?? []).filter(item => !item.retracted_at).map(item => text(item.claim)).filter(Boolean),
    options: record.input.options.map(option => text(option.label)),
    chosen: text(record.decision.move ?? label(record.decision.option_id)),
    why: text(record.decision.reason),
    next_step: text(record.decision.next_action),
    measured_by: text(record.decision.success_measure),
    thinking: thinking.map(text).filter(Boolean),
    outcome: outcome ? { result: outcome.result, what_happened: text(outcome.what_happened) } : null,
  };
  while (JSON.stringify(facts).length > limit && (facts.thinking.length || facts.context.length)) {
    if (facts.thinking.length) facts.thinking.pop();
    else facts.context.pop();
  }
  facts.context = facts.context.map(item => clip(item, 600));
  return facts;
}
