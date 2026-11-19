// tools/watch-my-sources/do-work/watch-my-sources.mjs
//
// tool:watch-my-sources, run as a function (tools/workflows do-work/run-a-function.mjs): one run of Watch my sources
// (read-data/watch-sources.mjs) over the person's records that the caller hands in as `records`. The places they follow are
// rows of their list `signal-sources`, what is new becomes rows of `signals`, a ranked list's ranks rows of
// `ranked-items`, and their pursuits are their `pursuit` records. The run reaches no store and keeps nothing: its answer
// holds `keep`, the records that keep what it found, each expecting the value it was handed in with, for the caller to
// put where the person keeps their rows.
//
// The run is handed no model and no arrival door, so the AI that runs it does both, in the same two-step way a source's
// whole history is taken in:
//   - weighing: when New signals wait, the answer names `weigh_wanted` { purpose, identity, messages, max_tokens }, the
//     one question for the oldest batch. The AI answers it (its own model, or the person's route for that purpose) and
//     runs again with `weighed` { identity, reply } and the records as the first run's keep left them. The question is
//     the same, byte for byte, until it is answered, and a reply is used only for the question whose identity it names,
//     so a stale answer never judges new items.
//   - handing in: each signal that moves a pursuit is answered in `arrivals`, each one exactly what the person's arrival
//     door takes (route `watch-sources`, from_person false, source_id). The door keeps one arrival per route and
//     source_id, so handing the same one in again adds nothing.
//
//   watchMySources(input, { read? }) -> the report of watchSources, plus keep, weigh_wanted? and arrivals
//   input: { records, sources_list_id?, items_list_id?, most_per_source?, history?, formats?: [{ id, label, description? }],
//            weighed?: { identity, reply } }
//   records: [{ id, type, value }] as the person's store holds them: the three lists (type `list`), their rows (type
//            `record:<row type>`) and the person's `pursuit` records.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { listsInHand } from '../read-data/lists-in-hand.mjs';
import { watchSources } from '../read-data/watch-sources.mjs';

const PURSUIT_FIELDS = ['title', 'after', 'status'];

/** The identity of one weighing question: its messages and max_tokens, as the person's waiting asks are kept. */
export const questionIdentity = ({ messages, max_tokens: maxTokens }) =>
  makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify([messages ?? [], maxTokens ?? null])));

export async function watchMySources(input = {}, { read = fetch, now = () => new Date() } = {}) {
  const { records, weighed, formats = [], ...rest } = input ?? {};
  if (!Array.isArray(records)) throw new Error('records is the person\'s lists, their rows and their pursuits as their store holds them: [{ id, type, value }].');
  if (weighed !== undefined && (typeof weighed?.identity !== 'string' || typeof weighed?.reply !== 'string')) {
    throw new Error('weighed is { identity, reply }: the identity of the weigh_wanted question and the reply to it.');
  }
  if (!Array.isArray(formats)) throw new Error('formats is a list of the person\'s content formats: [{ id, label, description }].');
  const lists = listsInHand(records);
  let wanted = null;
  const arrivals = [];
  const report = await watchSources({
    lists,
    read,
    now,
    pursuits: async () => lists.rowsOfType('pursuit', PURSUIT_FIELDS).map(({ id, value }) => ({ id, ...value })),
    formats: async () => formats,
    ask: async request => {
      const identity = questionIdentity(request);
      if (weighed?.identity === identity) return { reply: weighed.reply };
      wanted = { purpose: 'signal-weigh', identity, messages: request.messages, max_tokens: request.max_tokens };
      // The question is kept for the AI that runs this tool; the items stay New until it answers.
      throw Object.assign(new Error('The weighing question waits for the AI that runs this tool.'), { no_chosen_ai: true });
    },
    arrive: async arrival => { arrivals.push(arrival); return {}; },
  }, rest);
  return { ...report, ...(wanted ? { weigh_wanted: wanted } : {}), arrivals, keep: lists.keep() };
}
