// src/activation.mjs
//
// Purpose
//   Says, for each published agent, whether handing it work starts it, and how: the answer find_agents and hand_off
//   carry (`activation`). A host is started only through its own documented interface: a chat subscribed to work
//   events (src/mcp-events.mjs), a consumer on the AI's own computer that holds an outbound connection to Trillion and
//   starts the session itself (harness/work-consumer.mjs, which records a binding here), or an agent that published a
//   delivery address (src/agent-delivery.mjs). Being able to reach a host is not the AI doing the work: read_handoff
//   shows whether it took and finished it.
//
// Non-negotiable invariants
//   1. The paths, their order, the contact window and every word are DATA (src/activation.json); nothing here names a
//      host, a vendor or a kind of work.
//   2. unsupported, offline and busy are different answers: no way to start the host, a way that is out of touch, and a
//      way that is live while the AI says it has no room.
//   3. A binding belongs to one published agent and is only ever written by a sign-in of the same account.
//
// store: { binding(agent_id), putBinding(binding) }
//
import rules from './activation.json' with { type: 'json' };

const minutesAgo = (iso, now) => (iso ? (now.getTime() - Date.parse(iso)) / 60_000 : Infinity);

// Each path's answer for one agent, or null when the agent has no such path. `live` true: reachable now.
const PATHS = {
  'chat-events': ({ agent, subscriptions }, settings) => {
    const found = subscriptions.find(item => item.name === settings.chat_event
      && (item.arguments?.agent_id ? item.arguments.agent_id === agent.agent_id : Boolean(agent.reader) && item.reader === agent.reader));
    return found ? { live: true, detail: { subscription_id: found.id, until: found.expires_at, delivered: found.delivered ?? 0, last_delivered_at: found.last_delivered_at ?? null } } : null;
  },
  'desktop-connection': ({ binding, now }, settings) => (binding ? {
    live: binding.supported !== false && minutesAgo(binding.last_contact_at, now) <= settings.contact_minutes,
    unsupported: binding.supported === false,
    detail: { host: binding.host ?? null, session: binding.session ?? null, last_contact_at: binding.last_contact_at ?? null, ...(binding.reason ? { reason: binding.reason } : {}) },
  } : null),
  // An address is live when the agent reported itself present lately; the stream route (a helper on its computer
  // holding the live connection, src/agent-delivery.mjs) is live only while that connection answers (stream_live).
  'delivery-address': ({ agent, now }) => (agent.delivery ? { live: agent.delivery.stream ? agent.stream_live === true : minutesAgo(agent.last_seen_at, now) <= 15, detail: { route: agent.delivery.stream ? 'stream' : 'push', last_seen_at: agent.last_seen_at ?? null } } : null),
};

/** How handing work to `agent` starts it: { state, path, says, detail }. */
export function activationOf({ agent, capacity = null, subscriptions = [], binding = null, now = new Date() }, settings = rules) {
  const found = settings.paths.map(path => ({ path, answer: PATHS[path]?.({ agent, subscriptions, binding, now }, settings) })).filter(item => item.answer);
  const live = found.find(item => item.answer.live);
  const pick = live ?? found.find(item => !item.answer.unsupported) ?? found[0] ?? null;
  const state = live ? (capacity?.status === 'full' ? 'busy' : 'starts_now') : pick && !pick.answer.unsupported ? 'offline' : 'unsupported';
  return { state, path: pick?.path ?? null, says: settings.states[state], ...(pick ? { detail: pick.answer.detail } : {}) };
}

/** A consumer on the AI's computer says it is there, which host it starts and whether that host can be started. */
export function bindingFrom(input, card, now = new Date()) {
  if (!card) throw new Error(`No agent ${input?.agent_id} has published on this account.`);
  const text = (value, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  return {
    agent_id: card.agent_id, host: text(input.host, 100), session: text(input.session, 200),
    supported: input.supported !== false, reason: input.supported === false ? text(input.reason, 500) : null,
    last_contact_at: now.toISOString(),
  };
}
