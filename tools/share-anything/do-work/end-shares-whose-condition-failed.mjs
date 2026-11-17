// tools/share-anything/do-work/end-shares-whose-condition-failed.mjs
//
// Purpose: The sharer's own condition on a share that lets people run their tools (tool:end-shares-whose-condition-failed):
// every row the sharer holds of kind data.run.end_kind (`{ grant, unused_days?, since, ends_at? }`, written by tool:share-anything
// with every run share: the default of read-data/access-ends-when-unused.json, and the sharer's own `until` as `ends_at`) whose
// end has passed (read-data/access-ends-when-unused.mjs `endOf`: the fixed end, or the later of `since` and the grant's last use
// the engine lists, plus unused_days) is withdrawn at the sharer's door, then its row is removed and the end is kept as a record of
// kind `grant-ended` for the sign-in tool's Connections page. The engine reads no end and no
// condition (trillion-rust src/account_rights/share_grant.rs): it admits a bearer while the share is kept, so ending one is
// this withdrawal. The tool's row declares a wake, which the sharer switches on (`wake:switch`); the run it starts acts only
// within the rights its row declares and the switcher's own (trillion-rust src/wake/tool_runner.rs), and holds no key. It
// wakes every checkEveryMs of read-data/access-ends-when-unused.mjs, a fraction of the unused window.
//
//   endSharesWhoseConditionFailed(input, { door })   input { now? } (an ISO time to decide at, now when left out) -> { ended,
//                                                    waiting, unjudged, said }; the one export the row runs.
//
// Non-Negotiable Invariants:
// - A share is withdrawn only when its row names an end that has passed by the run's own clock: a fixed time, or the unused days
//   counted from the later of the row's `since` and the last use the engine lists for that grant. A row that names neither, or
//   a time that is not one, is left alone and counted as waiting (nothing here ends a share it cannot read the end of).
// - A grant the engine lists with no `last_used` field is judged by its fixed end alone and counted in `unjudged`, said aloud: a
//   share that is in use is never ended on a use this run could not read. A grant listed with `last_used: null` was never used.
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
import { ended as endedRecords, endedRecord, endOf, words as endWords } from '../read-data/access-ends-when-unused.mjs';
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

/** The grant's last use as the engine lists it for that one label (a run may list only the label its right names): an ISO time, null when never used, undefined when the engine answers none. */
async function lastUseOf(door, grant) {
  const { grants } = await door.sharing(runs.list_operation, { label: grant });
  const held = Array.isArray(grants) ? grants.find(item => object(item) && item.label === grant) : undefined;
  return held && Object.hasOwn(held, 'last_used') ? held.last_used : undefined;
}

export async function endSharesWhoseConditionFailed(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The input is an object, or left out.');
  const now = nowOf(input);
  const ended = [];
  let waiting = 0;
  let unjudged = 0;
  for await (const row of door.list({ type: runs.end_kind, prefix: runs.end_prefix })) {
    const value = row.value;
    if (!object(value) || typeof value.grant !== 'string' || !value.grant.startsWith(data.record_prefix)) {
      waiting += 1;
      continue;
    }
    const used = typeof value.unused_days === 'number' ? await lastUseOf(door, value.grant) : undefined;
    if (used === undefined && typeof value.unused_days === 'number') unjudged += 1;
    const end = endOf(value, used);
    if (end === null || end.at > now) {
      waiting += 1;
      continue;
    }
    const key = `${row.id}:${new Date(end.at).toISOString()}`;
    await door.sharing(runs.withdraw_operation, { label: value.grant }, { key: `withdraw:${key}` });
    await door.write([
      { id: `${endedRecords.prefix}${value.grant}`, type: endedRecords.kind, value: endedRecord({ grant: value.grant, at: now, reason: end.reason, days: value.unused_days ?? null }) },
      { id: row.id, type: runs.end_kind, value: null },
    ], { key: `remove:${key}` });
    ended.push(value.grant);
  }
  const said = [fill(ended.length ? data.words.swept : data.words.sweep_nothing, { ended: ended.length, waiting }),
    ...(unjudged ? [fill(endWords.unjudged, { count: unjudged })] : [])].join(' ');
  return { ended, waiting, unjudged, said };
}
