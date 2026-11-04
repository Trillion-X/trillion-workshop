// The choices an account made among the tools find_tool_for_job offered it for a job, kept as training pairs: the job
// (the situation), every candidate offered, the one run for that same job, and its run's state. A find that offers two or
// more candidates keeps them under `choice:tool:<32 hex of the job's BLAKE3>`, with `<that>:pool` (the candidate ids)
// between the find and the run; a run of one of them for the same job marks it chosen and pools the choice set with no
// content (how many candidates, which position was run). How long they are kept: src/tool-choice-keep.mjs.
//
//   toolChoices({ store, keep, keepsOffers, shares, pooled }) -> { offered(sent, reply), ran(sent, reply), chosen() }
//   store        the account's records (src/decision-store.mjs): setting(name), setSetting(name, value), settings(prefix)
//   keep         the account's toolChoiceKeep (due, noted)
//   keepsOffers  async: whether this account's plan keeps the candidates offered (a plan with a decision limit does not)
//   shares()     async: whether this account shares what it decides now (its share choice, else the sharing default,
//                src/sharing-choice.mjs); an account that does not share pools nothing
//   pooled(set)  pools one content-free choice set: { source: 'tool', method: null, choice_key, candidate_count, chosen_index }
//   offered      after a find: keeps the candidates offered for its job; the same candidates again write nothing
//   ran          after a run: marks the run's tool chosen among the candidates its job was offered, and pools the set
//   chosen()     every kept choice that was chosen from, as /choices lists it beside the account's decisions
//
//   chosenToolChoices(store) -> the same list, for a store that keeps choices made before but makes no new ones
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const PREFIX = 'choice:tool:';
const job = sent => (typeof sent?.job === 'string' ? sent.job.trim() : '');
const nameOf = text => `${PREFIX}${bytesToHex(blake3(new TextEncoder().encode(text))).slice(0, 32)}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function toolChoices({ store, keep, keepsOffers, shares, pooled }) {
  return {
    async offered(sent, reply) {
      const situation = job(sent);
      if (!situation) return;
      const candidates = (reply?.candidates ?? []).map(card => ({ id: card.tool_id, text: `${card.label ?? card.tool_id}: ${card.job ?? ''}`.trim() }));
      if (candidates.length < 2) return;
      // The same job offered the same candidates again learns nothing, so it writes nothing: an AI that asks for the same
      // job every turn wrote two settings a find (764k rows an hour on 2026-10-08). A choice already made among these
      // candidates stays; a run of another tool among them updates it. `at` is when the choice was last offered or chosen
      // from, written again at most every refresh_hours, so the choices nobody asks about any more can be dropped.
      const name = nameOf(situation);
      const choice_id = name.slice('choice:'.length);
      const at = new Date().toISOString();
      const kept = store.setting(name);
      if (!same(kept?.candidates, candidates) && await keepsOffers()) store.setSetting(name, { source: 'tool', choice_id, situation, candidates, chosen_index: null, outcome: null, at });
      else if (kept && keep.due(kept)) store.setSetting(name, { ...kept, at });
      const ids = candidates.map(item => item.id);
      const pool = store.setting(`${name}:pool`);
      if (!same(pool?.candidates, ids)) store.setSetting(`${name}:pool`, { choice_id, candidates: ids, at });
      else if (keep.due(pool)) store.setSetting(`${name}:pool`, { ...pool, choice_id, at });
      keep.noted();
    },
    async ran(sent, reply) {
      const situation = job(sent);
      if (!situation) return;
      const name = nameOf(situation);
      const offered = store.setting(`${name}:pool`);
      if (!offered) return;
      const chosen_index = offered.candidates.indexOf(sent.tool_id);
      const kept = store.setting(name);
      if (kept && (kept.chosen_index === null || kept.chosen_id !== sent.tool_id)) store.setSetting(name, { ...kept, chosen_index, chosen_id: sent.tool_id, outcome: null, execution_state: reply?.state ?? null, at: new Date().toISOString() });
      else if (kept && keep.due(kept)) store.setSetting(name, { ...kept, at: new Date().toISOString() });
      store.setSetting(`${name}:pool`, null);
      if (await shares()) await pooled({ source: 'tool', method: null, choice_key: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), candidate_count: offered.candidates.length, chosen_index });
    },
    chosen: () => chosenToolChoices(store),
  };
}

export function chosenToolChoices(store) {
  return store.settings(PREFIX).map(row => row.value).filter(item => item?.chosen_index !== null && item?.chosen_index !== undefined)
    .map(item => ({ ...item, outcome: null, ...(item.outcome ? { legacy_execution_result: item.outcome } : {}) }));
}
