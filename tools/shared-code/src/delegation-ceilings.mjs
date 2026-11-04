// src/delegation-ceilings.mjs
//
// PURPOSE
//   What a person lets one of their AIs do on their behalf. The limit is a ceiling kept on the AI's own row
//   ({ deny, allow }, src/delegation-ceilings.json): the person sets it with limit_your_ai, and the place that admits an
//   AI to waiting work (src/own-ais.mjs covers, used by pick and by the agents' canTake) refuses a job whose needs the
//   ceiling does not permit. A job from an automation can carry a ceiling of its own; it can only tighten.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No ceiling means no limit: nothing here refuses work for an AI whose person set none.
//   2. A ceiling only limits. effective() never returns more than the AI's own ceiling permits, whatever the job asked.
//   3. A job's attempt to widen is named (ignored) and never applied.
//   4. Words and field names are DATA (src/delegation-ceilings.json).
//
import data from './delegation-ceilings.json' with { type: 'json' };

const wordsOf = list => (Array.isArray(list) ? list.filter(word => typeof word === 'string' && word.trim()).map(word => word.trim()) : []);
const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text);

/** A ceiling as the person wrote it, or null when it limits nothing. Throws plain words for a field that is not a list of words. */
export function settle(input) {
  if (input === null || input === undefined) return null;
  const out = {};
  for (const field of data.limit_fields) {
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field]) || input[field].some(word => typeof word !== 'string' || !word.trim())) throw new Error(fill(data.words.bad_list, { field }));
    out[field] = [...new Set(wordsOf(input[field]))];
  }
  return Object.keys(out).length && (out.deny?.length || out.allow) ? out : null;
}

/** The ceiling `requested` can have under `base`: base's denials stay and grow, its allowed set only shrinks. { ceiling, widened } */
export function tighten(base, requested) {
  const held = settle(base), asked = settle(requested);
  if (!asked) return { ceiling: held, widened: [] };
  if (!held) return { ceiling: asked, widened: [] };
  const deny = [...new Set([...(held.deny ?? []), ...(asked.deny ?? [])])];
  const widened = (held.deny ?? []).filter(word => !(asked.deny ?? []).includes(word) && asked.allow?.includes(word));
  let allow = held.allow ?? asked.allow;
  const beyond = held.allow && asked.allow ? asked.allow.filter(word => !held.allow.includes(word)) : [];
  if (held.allow && asked.allow) allow = asked.allow.filter(word => held.allow.includes(word));
  return { ceiling: settle({ ...(deny.length ? { deny } : {}), ...(allow ? { allow } : {}) }), widened: [...widened, ...beyond] };
}

/** Why `ceiling` does not permit work needing `needs`, or null when it does. */
export function refusal(ceiling, needs) {
  const held = settle(ceiling);
  if (!held) return null;
  const real = needs.filter(need => need !== data.every_need);
  const checked = real.length ? real : [data.every_need];
  const denied = checked.filter(need => held.deny?.includes(need));
  if (denied.length) return fill(data.words.denied, { needs: denied.join(', ') });
  if (held.allow) {
    const outside = real.filter(need => !held.allow.includes(need));
    if (outside.length || (!real.length && !held.allow.includes(data.every_need))) return fill(data.words.not_allowed, { allowed: held.allow.join(', ') || 'nothing' });
  }
  return null;
}

/** The ceiling in force for a job on an AI row: the row's, tightened by the job's own (input.ceiling). */
export const effective = (row, job) => tighten(row?.ceiling, job?.input?.ceiling).ceiling;
