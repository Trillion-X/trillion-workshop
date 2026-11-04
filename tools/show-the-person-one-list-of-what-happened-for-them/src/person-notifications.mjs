// src/person-notifications.mjs
//
// PURPOSE
//   The person's notifications: one list, newest first, of what happened for them that Trillion already keeps a record
//   of, each with the person's own read mark. The list is read from the records themselves every time (a request sent
//   to them in the network, a space with items they have not seen, work handed to their AIs), so a notification
//   can never say something the records do not; the only thing kept here is which ones the person has read.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No row is made up: every row is one record a reader below found, and its id names that record (and the state
//      it is in, when a new state is news: an invitation accepted, new items in a space, work finished).
//   2. What a kind says and offers is DATA (src/person-notifications.json); a missing fact leaves its words out rather
//      than showing a blank or a guess.
//   3. Read state is one mark per notification id in the person's own store (src/seen-marks.mjs); marking unread
//      removes the mark. A mark on a row that no longer exists does nothing.
//   4. A source that cannot be read leaves its rows out; the rest of the list still answers.
//   5. Work handed to an AI speaks by its `said` (the work as the person sees it); its `job`, the instructions written
//      for the AI with their tool names and ids, is never a fact here, so no row can show it.
//   6. Each row names what it is `about` (the request, the space, or the press that asked for the work), so a control
//      on that thing in the app can follow it; whether a row says work is still going on is its kind's `running`.
//
// Security
//   Reads only this person's own store and the network's answers about this person's relay; nothing across people.
import settings from '../../shared-code/src/person-notifications.json' with { type: 'json' };
import { seenMarks } from '../../shared-code/src/seen-marks.mjs';

export const NOTIFICATION_READ = { table: 'notification_read', place: 'notification', reader: 'reader' };
const READER = 'person';
const DAY_MS = 86_400_000;

// "{from} invited you to {space}" with the row's facts; a line whose fact is missing uses the kind's `_without` words
// for it, or is left out.
function fill(template, facts) {
  if (typeof template === 'string') {
    const missing = [...template.matchAll(/\{(\w+)\}/g)].some(([, name]) => facts[name] === undefined || facts[name] === null || facts[name] === '');
    return missing ? null : template.replace(/\{(\w+)\}/g, (_, name) => String(facts[name]));
  }
  if (Array.isArray(template)) return template.map(value => fill(value, facts));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, facts)]));
  return template;
}
const words = (kind, field, facts) => {
  const direct = fill(kind[field], facts);
  if (direct !== null) return direct;
  const fallback = Object.entries(kind[`${field}_without`] ?? {}).find(([name]) => !facts[name])?.[1];
  return fallback ? fill(fallback, facts) : null;
};

// Who a row is about, as its kind's `face` names it ({ name, app }), or null when the name is not known.
const faceOf = (kind, facts) => {
  const name = kind.face ? fill(kind.face.name, facts) : null;
  return name ? { name, app: fill(kind.face.app, facts) } : null;
};

// The records each source keeps, as rows { id, kind, at, facts }.
// Requests arrive as the network's network-request records (src/network.mjs requestRecords).
const fromRequests = requests => requests.map(({ record: request }) => {
  const space = request.space_id ? { title: request.space, membership_id: request.space_id } : null;
  const facts = { request_id: request.request_id, from: request.from, why: request.why, space: space?.title, space_id: space?.membership_id };
  if (request.status === 'accepted') return { id: `request:${request.request_id}`, about: request.request_id, kind: space ? 'space-joined' : 'introduction-accepted', at: request.answered_at ?? request.asked_at, facts };
  return { id: `request:${request.request_id}`, about: request.request_id, kind: space ? 'space-invitation' : 'introduction', at: request.asked_at, facts, waiting: true };
});
const fromSpaces = spaces => spaces.filter(space => space.unread > 0).map(space => ({
  id: `space:${space.space_id}:${space.last_activity_at}`, about: space.space_id, kind: 'space-new-items', at: space.last_activity_at,
  facts: { count: space.unread, space: space.title, space_id: space.space_id },
}));
// What came back, in words, when the AI gave no summary: its text, or its `outcome` or `summary` field, cut short.
const RESULT_WORDS_MAX = 300;
const resultWords = result => {
  const said = typeof result === 'string' ? result : typeof result?.outcome === 'string' ? result.outcome : typeof result?.summary === 'string' ? result.summary : null;
  return said ? (said.length > RESULT_WORDS_MAX ? `${said.slice(0, RESULT_WORDS_MAX - 1)}…` : said) : null;
};
// How far a job has got, in words: the kept calls made for it ("3 steps"), or nothing before the first one.
const stepWords = count => (count > 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : null);
const fromWork = (work, agents, since) => {
  const agentOf = id => agents.find(agent => agent.agent_id === id) ?? null;
  return work.flatMap(item => {
    // What the work is about: the press that asked for it (a button's job, handed on by the person's rules or held for
    // the AI connected now, whose handoff is the press itself), else the handoff.
    const about = item.input?.arrived?.asked_id ?? item.handoff_id;
    // Who has it (the AI that took it, else the one it was handed to) with the app it connected as, so its face leads.
    const holder = item.taken_by ?? item.to_agent;
    const facts = { said: item.said, agent: agentOf(holder)?.name ?? item.taken_by, agent_app: agentOf(holder)?.app ?? null, steps: stepWords(item.steps), handoff_id: item.handoff_id };
    if (item.state === 'finished') return item.finished_at > since ? [{ id: `handoff:${item.handoff_id}:finished`, about, kind: 'work-finished', at: item.finished_at, facts: { ...facts, summary: item.summary ?? resultWords(item.result) } }] : [];
    // Taken: the AI working on it now is named, so a press shows who has it before the result comes back.
    if (item.state === 'taken' && item.taken_by) return [{ id: `handoff:${item.handoff_id}:taken`, about, kind: 'work-taken', at: item.taken_at ?? item.handed_at, facts, waiting: true }];
    return [{ id: `handoff:${item.handoff_id}:waiting`, about, kind: 'work-waiting', at: item.handed_at, facts: { ...facts, agent: agentOf(item.to_agent)?.name ?? null }, waiting: true }];
  });
};

/**
 * The list. `read` answers the sources the store hands in: { requests(since), spaces(), work({ since, limit, exclude_from }) } (each async); a source
 * that throws is left out. Returns { items: [{ id, about, kind, at, title, detail, face, chips, actions, read, waiting, running, working }], unread }.
 */
export async function readPersonNotifications(sql, read, { now = new Date(), config = settings } = {}) {
  const since = new Date(now.getTime() - config.window_days * DAY_MS).toISOString();
  const settled = async (reader, shape) => {
    try { return shape(await reader()); }
    catch (error) {
      // An upgrading work index is an explicitly incomplete read. The notification keeper catches this failed read
      // quietly and retains its shown list; the shared API retries HTTP503, and the host publishes readiness later.
      if (error?.notification_index_building === true) throw error;
      return [];
    }
  };
  const rows = (await Promise.all([
    settled(() => read.requests(since), fromRequests),
    settled(() => read.spaces(), fromSpaces),
    settled(() => read.work({ since, limit: config.most, exclude_from: config.not_work_from ?? [] }), ({ work, agents }) => fromWork(work.filter(item => !(config.not_work_from ?? []).includes(item.from_agent)), agents, since)),
  ])).flat().filter(row => config.kinds[row.kind] && row.at);
  const visible = rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, config.most);
  const marks = seenMarks(sql, NOTIFICATION_READ).marksFor(READER, visible.map(row => row.id));
  const items = visible.map(row => {
    const kind = config.kinds[row.kind];
    return {
      id: row.id, about: row.about ?? null, kind: row.kind, at: row.at, waiting: Boolean(row.waiting), running: Boolean(kind.running), working: Boolean(kind.working),
      title: words(kind, 'title', row.facts), detail: words(kind, 'detail', row.facts) ?? null,
      face: faceOf(kind, row.facts),
      chips: (kind.chips ?? []).map(chip => fill(chip, row.facts)).filter(chip => chip.text),
      actions: (kind.actions ?? []).map(action => fill(action, row.facts)).filter(action => !JSON.stringify(action).includes('null')),
      read: Boolean(marks[row.id]),
    };
  }).filter(item => item.title);
  return { items, unread: items.filter(item => !item.read).length };
}

/** The person has read (or, with read false, not read) the notifications `ids`. */
export function markPersonNotifications(sql, { ids, read = true, now = new Date() } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) throw new Error('Name the notifications as a list of their ids.');
  const marks = seenMarks(sql, NOTIFICATION_READ);
  for (const id of ids) read === false ? marks.forget(id, READER) : marks.mark(id, READER, now.toISOString());
  return { ids, read: read !== false };
}
