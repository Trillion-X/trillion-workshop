// tools/watch-my-sources/do-work/watch-my-sources.mjs
//
// tool:watch-my-sources, run as a function (tools/records-door do-work/run-an-export.mjs): one run of Watch my sources
// (read-data/watch-sources.mjs) over the person's own records through their records door. The places they follow are
// rows of their list `signal-sources`, what is new becomes rows of `signals`, a ranked list's ranks rows of
// `ranked-items`, and their pursuits are their `pursuit` records.
//
// The run is handed no model and no arrival door, so the AI that runs it does both, in the same two-step way a source's
// whole history is taken in:
//   - weighing: when New signals wait, the answer names `weigh_wanted` { purpose, identity, messages, max_tokens }, the
//     one question for the oldest batch. The AI answers it (its own model, or the person's route for that purpose) and
//     runs again with `weighed` { identity, reply }. The question is the same, byte for byte, until it is answered, and
//     a reply is used only for the question whose identity it names, so a stale answer never judges new items.
//   - handing in: each signal that moves a pursuit is answered in `arrivals`, each one exactly what the person's arrival
//     door takes (route `watch-sources`, from_person false, source_id). The door keeps one arrival per route and
//     source_id, so handing the same one in again adds nothing.
//
//   watchMySources(input, { door, read? }) -> the report of watchSources, plus weigh_wanted? and arrivals
//   input: { sources_list_id?, items_list_id?, most_per_source?, history?, formats?: [{ id, label, description? }],
//            weighed?: { identity, reply } }
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { watchSources } from '../read-data/watch-sources.mjs';

const PURSUIT_FIELDS = ['title', 'after', 'status'];

/** The identity of one weighing question: its messages and max_tokens, as the person's waiting asks are kept. */
export const questionIdentity = ({ messages, max_tokens: maxTokens }) =>
  makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify([messages ?? [], maxTokens ?? null])));

export async function watchMySources(input = {}, { door, read = fetch, now = () => new Date() } = {}) {
  const { weighed, formats = [], ...rest } = input ?? {};
  if (weighed !== undefined && (typeof weighed?.identity !== 'string' || typeof weighed?.reply !== 'string')) {
    throw new Error('weighed is { identity, reply }: the identity of the weigh_wanted question and the reply to it.');
  }
  if (!Array.isArray(formats)) throw new Error('formats is a list of the person\'s content formats: [{ id, label, description }].');
  let wanted = null;
  const arrivals = [];
  const report = await watchSources({
    lists: listsOverDoor(door),
    read,
    now,
    pursuits: async () => {
      const rows = [];
      for await (const record of door.list({ type: 'pursuit', fields: PURSUIT_FIELDS })) rows.push({ id: record.id, ...(record.value ?? {}) });
      return rows;
    },
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
  return { ...report, ...(wanted ? { weigh_wanted: wanted } : {}), arrivals };
}
