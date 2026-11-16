// tools/share-anything/do-work/end-shares-whose-condition-failed.mjs
//
// Purpose: The sharer's own condition on a share that lets people run their tools (tool:end-shares-whose-condition-failed):
// every row the sharer holds of kind data.run.end_kind (`{ grant, ends_at }`, written by tool:share-anything when it is given
// `until`) whose end has passed is withdrawn at the sharer's door, then its row is removed. The engine reads no end and no
// condition (trillion-rust src/account_rights/share_grant.rs): it admits a bearer while the share is kept, so ending one is
// this withdrawal. The tool's row declares a wake, which the sharer switches on (`wake:switch`); the run it starts acts only
// within the rights its row declares and the switcher's own (trillion-rust src/wake/tool_runner.rs), and holds no key.
//
//   endSharesWhoseConditionFailed(input, { door })   input { now? } (an ISO time to decide at, now when left out) -> { ended,
//                                                    waiting, said }; the one export the row runs.
//
// Non-Negotiable Invariants:
// - A share is withdrawn only when its row names a time that has passed by the run's own clock; a row that names no time, or a
//   time that is not one, is left alone and counted as waiting (nothing here ends a share it cannot read the end of).
// - The withdrawal comes first and the row goes second, each under a key made from the row and its end, so a run sent again, or a
//   second sweep that finds the row still there, withdraws once and removes once.
// - A withdrawal the door refuses is not hidden: the sweep stops with that refusal and removes no row, so the next sweep tries again.
// - This run keeps nothing, makes no grant and reads no record but the rows of its kind.
//
// Security Considerations: the row grants this run the withdraw and list operations on labels that start with data.record_prefix,
// never the keep operation, so it can only end a share, and the rows of one kind to read and remove.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import data from '../read-data/share-anything.json' with { type: 'json' };

const runs = data.run;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

export async function endSharesWhoseConditionFailed(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The input is an object, or left out.');
  const now = nowOf(input);
  const ended = [];
  let waiting = 0;
  for await (const row of door.list({ type: runs.end_kind, prefix: runs.end_prefix })) {
    const value = row.value;
    const at = object(value) && typeof value.ends_at === 'string' ? Date.parse(value.ends_at) : NaN;
    if (!Number.isFinite(at) || at > now || typeof value.grant !== 'string' || !value.grant.startsWith(data.record_prefix)) {
      waiting += 1;
      continue;
    }
    const key = `${row.id}:${value.ends_at}`;
    await door.sharing(runs.withdraw_operation, { label: value.grant }, { key: `withdraw:${key}` });
    await door.write([{ id: row.id, type: runs.end_kind, value: null }], { key: `remove:${key}` });
    ended.push(value.grant);
  }
  return { ended, waiting, said: fill(ended.length ? data.words.swept : data.words.sweep_nothing, { ended: ended.length, waiting }) };
}
