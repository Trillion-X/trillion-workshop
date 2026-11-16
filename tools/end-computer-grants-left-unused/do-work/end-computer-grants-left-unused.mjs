// tools/end-computer-grants-left-unused/do-work/end-computer-grants-left-unused.mjs
//
// Purpose: The person's own condition on the computer capabilities they granted their tools (tool:end-computer-grants-left-unused):
// a grant that has gone unused for `unused_days` ends, and the person is reminded `remind_days` before it does. The owner's decision
// case source:bWVzc2FnZXMtYmVjb21lLXNlZWRzOmdyYW50LWxhcHNlLWZvci1haS1zZXNzaW9uLWZvbGRlcnMtMjAyNi0xMS0xMw (ninety days with a reminder)
// is the default. The engine reads no end and no window (trillion-rust src/tool_runs/tools/computer/grants.rs): a grant is
// admitted by being present, so ending one is this withdrawal. The engine keeps and answers two facts about each grant, when it
// was accepted and when a run last used it; this reads them and decides from them. The tool's row declares a wake, which the
// person switches on (`wake:switch`); the run it starts acts only within the rights its row declares and the switcher's own
// (trillion-rust src/wake/tool_runner.rs), and holds no key.
//
//   endComputerGrantsLeftUnused(input, { door })   input { now?, unused_days?, remind_days? } (an ISO time to decide at, now when
//                                                  left out; days, the DATA defaults when left out) -> { ended, reminded,
//                                                  waiting, said }; the one export the row runs.
//
// Non-Negotiable Invariants:
// - A grant ends only when the later of the time it was accepted and the time it was last used, plus `unused_days`, has passed by
//   the run's own clock. A grant that names neither time is left alone and counted as waiting: nothing here ends what it cannot
//   read the time of.
// - The withdrawal comes first and is made under a key made from the grant and the time it was last used, so a run sent again, or a
//   second sweep that finds the grant still there, withdraws once; a use between two sweeps moves the time and so is a new grant
//   window, never an ended one.
// - A reminder is one row, made once and left as the person leaves it: a run that finds it does not write it again, so a task the
//   person finished stays finished. A reminder whose grant was used since, ended or is no longer found is removed.
// - A withdrawal the door refuses is not hidden: the sweep stops with that refusal and writes no reminder, so the next sweep tries again.
// - This run makes no grant and keeps nothing but the reminder rows of its kind.
//
// Security Considerations: the row grants this run the withdraw and list operations on every tool's computer grants, never an
// operation that makes one, and the rows of one kind and prefix to read, write and remove.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import data from '../read-data/end-computer-grants-left-unused.json' with { type: 'json' };

const DAY = 86_400_000;
const reminder = data.reminder;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

function daysOf(input, name, standing, least) {
  const days = input[name] === undefined ? standing : input[name];
  if (typeof days !== 'number' || !Number.isFinite(days) || days < least) throw new Error(`${name} must be a number of days, at least ${least}.`);
  return days;
}

/** The name of the reminder of one grant at the time it was last used or accepted. */
const reminderIdOf = (tool, capability, since) => `${reminder.prefix}${encodeURIComponent(tool)}:${encodeURIComponent(capability)}:${since}`;

export async function endComputerGrantsLeftUnused(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The input is an object, or left out.');
  const now = nowOf(input);
  const unusedDays = daysOf(input, 'unused_days', data.unused_days, 1);
  const remindDays = daysOf(input, 'remind_days', data.remind_days, 0);
  if (remindDays >= unusedDays) throw new Error('remind_days must be fewer than unused_days.');
  const listed = await door.computerGrants(data.list_operation, {});
  const ended = [];
  const wanted = new Map();
  let waiting = 0;
  for (const entry of Array.isArray(listed?.tools) ? listed.tools : []) {
    // A grant that holds nothing as it stands (an old shape the engine refuses) is the person's to offer again, not this sweep's.
    if (!object(entry) || entry.granted !== true || typeof entry.tool !== 'string' || typeof entry.capability !== 'string') continue;
    const times = [entry.granted_at, entry.last_used].filter(Number.isFinite);
    if (!times.length) { waiting += 1; continue; }
    const since = Math.max(...times);
    const endsAt = since + unusedDays * DAY;
    if (now >= endsAt) {
      await door.computerGrants(data.withdraw_operation, { tool: entry.tool, capability: entry.capability }, { key: `withdraw:${entry.tool}:${entry.capability}:${since}` });
      ended.push(`${entry.tool} ${entry.capability}`);
      continue;
    }
    waiting += 1;
    if (now >= endsAt - remindDays * DAY) wanted.set(reminderIdOf(entry.tool, entry.capability, since), { entry, endsAt });
  }
  const standing = new Set();
  for await (const row of door.list({ type: reminder.kind, prefix: reminder.prefix })) {
    if (wanted.has(row.id)) { standing.add(row.id); continue; }
    await door.write([{ id: row.id, type: reminder.kind, value: null }], { key: `remove:${row.id}` });
  }
  let reminded = 0;
  for (const [id, { entry, endsAt }] of wanted) {
    if (standing.has(id)) continue;
    const title = fill(data.words.reminder, { tool: entry.tool, capability: entry.capability, ends: new Date(endsAt).toISOString().slice(0, 10) });
    await door.write([{ id, type: reminder.kind, value: { collection_id: [reminder.list], title } }], { key: `remind:${id}` });
    reminded += 1;
  }
  return { ended, reminded, waiting, said: fill(ended.length ? data.words.swept : data.words.sweep_nothing, { ended: ended.length, reminded, waiting }) };
}
