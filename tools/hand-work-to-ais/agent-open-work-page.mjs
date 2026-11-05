// A bounded account read for the computer helper. It carries only the fields needed to decide which chat may take
// work and what goes first (priority, src/inbound-words.json); full job text is read by handoff_id after a claim. The
// agents' store walks open handoffs oldest first a page at a time.
//
// Non-negotiable invariants: when any AI may take a chat's job (anyone_from) comes from the one owner, src/agents.mjs
// anyoneFrom, never a second copy of its rule; and one row never fails the page: a job whose arrival time cannot be
// read still lists, marked time_unreadable so its stored time can be found and repaired. On 2026-10-07 this page kept
// its own copy reading a setting renamed that day (chat_first_minutes to chat_silence_minutes), so every chat's job
// made the whole read answer "Invalid time value": the computer helper saw only work announced to it one job at a
// time, and the person's shares sat untaken.
import { anyoneFrom, workAgentCards } from '../shared-code/src/agents.mjs';

const PAGE_LIMIT = 50;
// Select from the authoritative handoff owner before hydration. Its projection
// retains identity/card fields; source input stays complete for anyoneFrom.
const WORK_FIELDS = { fields: ['priority', 'hold_until', 'in_the_way', 'input', 'depends_on', 'source_active_at', 'target'] };

export function agentOpenWorkPage(store, { after = null, limit = PAGE_LIMIT, agent_scope, handoff_id = null } = {}) {
  if (agent_scope !== undefined && agent_scope !== 'work') throw new Error('That agent scope is not available.');
  if (handoff_id !== null && (agent_scope !== 'work' || typeof handoff_id !== 'string' || !handoff_id)) throw new Error('Name one job in the work agent scope.');
  const size = Math.min(Math.max(Number.isInteger(limit) ? limit : PAGE_LIMIT, 1), PAGE_LIMIT);
  if (after !== null && !store.handoff(after, { projection: { fields: ['handed_at'] } })) throw new Error('That work page no longer exists. Start from the first page.');
  const rows = handoff_id ? [store.handoff(handoff_id, { projection: WORK_FIELDS })].filter(Boolean)
    : store.openHandoffs({ after, limit: size + 1, projection: WORK_FIELDS });
  const work = rows.slice(0, size).map(item => {
    const arrived = item.input?.arrived ?? {};
    const waiting = (item.depends_on ?? []).some(id => store.handoff(id, { projection: { fields: ['state'] } })?.state !== 'finished');
    const anyone = anyoneFrom(item);
    return {
      handoff_id: item.handoff_id, handed_at: item.handed_at, state: item.state ?? null, to_agent: item.to_agent ?? null, priority: item.priority ?? 0,
      hold_until: item.hold_until ?? null, in_the_way: item.in_the_way ?? null, in_the_way_by: item.in_the_way_by ?? null,
      input: arrived.source_id ? { arrived: { source_id: arrived.source_id, from_person: arrived.from_person === true } } : null,
      ...(waiting ? { next_step: { kind: 'dependency' } } : {}),
      ...(typeof item.handed_at === 'string' && Number.isFinite(Date.parse(item.handed_at)) ? {} : { time_unreadable: true }),
      ...(anyone ? { anyone_from: anyone } : {}),
    };
  });
  // Older helpers replace their card list on each page. Keep their directory until they request work-scoped cards
  // and retain those cards across pages; a named read resolves that exact job's source, not the first backlog row.
  const cards = agent_scope === 'work' ? workAgentCards(store, rows.slice(0, size), { sourceOwners: true }) : store.cards();
  const agents = cards.map(card => ({ agent_id: card.agent_id, takes_work: card.takes_work === true, source_id: card.source_id ?? null }));
  return { work, agents, next_after: rows.length > size ? work.at(-1).handoff_id : null };
}
