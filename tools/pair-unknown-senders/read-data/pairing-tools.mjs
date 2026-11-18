// tools/pair-unknown-senders/read-data/pairing-tools.mjs
//
// The four rows, each a function of its input alone: makeSenderPairing (sender-pairing.mjs, moved unchanged) is handed the
// pairing facts the caller read from wherever the person keeps them (`facts`: name -> value), and each answer carries
// `keep`, the facts to write back ([{ name, value }], the newest value per name being the current one). Nothing here
// reaches a database: the AI writes `keep` to the person's own database itself. Writing a fact again changes nothing.
import { makeSenderPairing } from './sender-pairing.mjs';

/** facts over the given values: { read(name), list(prefix), write(name, value) }, with every write gathered in `kept`. */
export function factsFrom(given = {}) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Error('facts must be an object of the pairing facts the person keeps, by name.');
  const held = new Map(Object.entries(given));
  const kept = new Map();
  return {
    kept,
    async read(name) { return structuredClone(held.get(name) ?? null); },
    async list(prefix) { return [...held].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => structuredClone(value)); },
    async write(name, value) { held.set(name, structuredClone(value)); kept.set(name, structuredClone(value)); },
  };
}

// One call over the given facts: the answer, with the facts it wrote as `keep`.
async function over(input, act) {
  const { facts: given, ...rest } = input ?? {};
  const facts = factsFrom(given ?? {});
  const answer = await act(makeSenderPairing({ facts }), rest);
  return { ...answer, keep: [...facts.kept].map(([name, value]) => ({ name, value })) };
}

/** tool:pair-an-unknown-sender: the code waiting for a sender, a new one, { paired: true } or { full: true }. */
export const requestPairing = input => over(input, (pairing, rest) => pairing.request(rest));
/** tool:approve-a-pairing-code: the person's yes to one waiting code. */
export const approvePairing = input => over(input, (pairing, rest) => pairing.approve(rest));
/** tool:unpair-a-sender: a paired sender is unknown again. */
export const revokePairing = input => over(input, (pairing, rest) => pairing.revoke(rest));
/** tool:list-paired-senders: what is waiting and who is paired, for one source or all. */
export const listPairing = input => over(input, async (pairing, rest) => {
  const listed = await pairing.list(rest);
  if (rest.sender && rest.source_id) return { ...listed, is_paired: await pairing.isPaired(rest) };
  return listed;
});
