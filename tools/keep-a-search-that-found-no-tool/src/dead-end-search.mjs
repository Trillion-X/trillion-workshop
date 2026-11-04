// src/dead-end-search.mjs
//
// A SEARCH THAT FINDS NOTHING IS KEPT IN THE PERSON'S OWN RECORDS AS A DEAD END.
//
// Purpose: when find_tool_for_job answers with no candidate, the job it was asked for is exactly what the person's Trillion
// does not cover yet. This keeps that miss (the job, how many times it was asked, when first and last) beside the choices
// the account keeps for tool jobs (src/tool-choices.mjs), so the account's own improvement work can read what was wanted and
// the next empty answer can say "asked N times before". It is the person's own data: nothing is sent anywhere and no choice
// is asked for. How long it is kept is src/tool-choice-keep.json (the same sweep drops it with the choices).
//
// Non-negotiable invariants:
//   1. The shortest job worth keeping, the cut, the ignored jobs and the words are DATA (./dead-end-search.json).
//   2. Only an answer with an empty `candidates` list is a dead end; an answer that failed, or one holding anything, is not.
//   3. The same job is one record (its BLAKE3 name): asking again counts up, written at most every refresh window.
//   4. The job is the AI's own description of the job, kept as a job, never as the person's words.
//
// Key concepts:
//   deadEndSearches({ store, keep, now, rules }) -> { missed(sent, reply) -> the dead end or null, list() -> every dead end }
//   store  the account's records (src/decision-store.mjs): setting(name), setSetting(name, value), settings(prefix)
//   keep   the account's toolChoiceKeep (due, noted)
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import rulesData from './dead-end-search.json' with { type: 'json' };

const nameOf = job => `${rulesData.name_prefix}${bytesToHex(blake3(new TextEncoder().encode(job))).slice(0, 32)}`;

/** The job a search asked for, tidied, or '' when it is too short to keep or is one the rules ignore. */
export function deadEndJob(sent, reply, rules = rulesData) {
  if (!Array.isArray(reply?.candidates) || reply.candidates.length > 0) return '';
  const job = typeof sent?.job === 'string' ? sent.job.trim().replace(/\s+/gu, ' ').slice(0, rules.most_job_characters) : '';
  return job.length < rules.min_characters || rules.ignore.includes(job.toLowerCase()) ? '' : job;
}

export function deadEndSearches({ store, keep, now = () => new Date(), rules = rulesData }) {
  const prefix = rules.name_prefix;
  return {
    async missed(sent, reply) {
      const job = deadEndJob(sent, reply, rules);
      if (!job) return null;
      const name = nameOf(job);
      const kept = store.setting(name);
      const at = now().toISOString();
      const times = (kept?.times ?? 0) + 1;
      const value = { source: 'tool', choice_id: name.slice('choice:'.length), kind: 'dead_end', job, times, first_at: kept?.first_at ?? at, at };
      // A job asked for every turn counts once per refresh window, so an AI that repeats it does not write each turn.
      if (!kept || keep.due(kept)) { store.setSetting(name, value); keep.noted(); return value; }
      return kept;
    },
    list: () => store.settings(prefix).map(row => row.value).filter(item => item?.kind === 'dead_end').sort((a, b) => (a.at < b.at ? 1 : -1)),
  };
}
