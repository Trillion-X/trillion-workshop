// src/held-sends.mjs
//
// PURPOSE
//   A real undo for a send. holdSend puts the send on the person's own schedules to run a few seconds from now and hands back a
//   cancel token; cancelHeldSend takes it back while it is still waiting; readHeldSend says whether it is waiting, sent or taken
//   back. The wait is server-side, so closing the app, losing the connection or switching device neither sends early nor loses
//   the undo. Nothing here sends: the schedule owner runs the Marketplace tool or workflow the caller names, with its retries,
//   health and run history.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no kind of send is named; what runs is the caller's `then`, the wait and every sentence are src/held-sends.json.
//   2. A send that already ran is never reported as taken back: cancel after the run says when it went out and changes nothing.
//   3. Cancelling removes the schedule, so a cancelled send cannot run later; cancelling twice is not an error the person
//      must fix: it answers that the send was already taken back.
//   4. The token is the only handle: it names one held send of this person's own schedules and nothing else.
//
import data from './held-sends.json' with { type: 'json' };

export class HeldSendError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const say = (key, values = {}) => data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const scheduleIdOf = token => `${data.schedule_prefix}${token}`;
const tokenOf = scheduleId => scheduleId.slice(data.schedule_prefix.length);
const validToken = token => typeof token === 'string' && /^[a-z0-9]{8,64}$/.test(token);

function stateOf(schedule) {
  if (schedule.ran_at) return { state: 'sent', at: schedule.ran_at };
  return { state: 'held', until: schedule.once_at };
}
const shown = schedule => {
  const { state, at, until } = stateOf(schedule);
  return {
    token: tokenOf(schedule.schedule_id), state, ...(until ? { until } : {}), ...(at ? { sent_at: at } : {}),
    label: schedule.label, then: { ...(schedule.then.tool_id ? { tool_id: schedule.then.tool_id } : { workflow_id: schedule.then.workflow_id }) },
    said: data.states[state].replace('{until}', until ?? '').replace('{at}', at ?? ''),
  };
};

/** Holds a send. input: { then, undo_seconds?, label? }. Answers { token, state: 'held', until, said }. */
export async function holdSend(automations, input = {}, { now = Date.now, newToken = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20) } = {}) {
  const then = input.then;
  if (!object(then) || !(typeof then.tool_id === 'string' || typeof then.workflow_id === 'string') || (then.input !== undefined && !object(then.input))) throw new HeldSendError(say('bad_then'));
  const seconds = input.undo_seconds === undefined ? data.default_undo_seconds : input.undo_seconds;
  if (!Number.isInteger(seconds) || seconds < data.least_undo_seconds || seconds > data.most_undo_seconds) {
    throw new HeldSendError(say('bad_seconds', { least: data.least_undo_seconds, most: data.most_undo_seconds }));
  }
  const token = newToken();
  const until = new Date(now() + seconds * 1000).toISOString();
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, data.label_chars) : (then.tool_id ?? then.workflow_id);
  await automations.setSchedule({ schedule_id: scheduleIdOf(token), once_at: until, label: `Send: ${label}`, then });
  return { token, state: 'held', until, said: say('held', { until }) };
}

async function schedulesOfHeldSends(automations) {
  return (await automations.listSchedules()).schedules.filter(schedule => typeof schedule.schedule_id === 'string' && schedule.schedule_id.startsWith(data.schedule_prefix) && schedule.once_at);
}

/** Where one held send stands: { token, state: 'held' | 'sent', ... }; a send that was taken back has no schedule left and reads as unknown. */
export async function readHeldSend(automations, input = {}) {
  if (!validToken(input.token)) throw new HeldSendError(say('bad_token'));
  const found = (await schedulesOfHeldSends(automations)).find(schedule => schedule.schedule_id === scheduleIdOf(input.token));
  if (!found) throw new HeldSendError(say('unknown', { token: input.token }));
  return shown(found);
}

/** The held sends waiting or recently sent, soonest first. */
export async function listHeldSends(automations) {
  const all = (await schedulesOfHeldSends(automations)).map(shown);
  return { held_sends: all.sort((a, b) => String(a.until ?? a.sent_at).localeCompare(String(b.until ?? b.sent_at))) };
}

/** Takes a held send back while it still waits. A send that already went out says when and changes nothing. */
export async function cancelHeldSend(automations, input = {}) {
  if (!validToken(input.token)) throw new HeldSendError(say('bad_token'));
  const found = (await schedulesOfHeldSends(automations)).find(schedule => schedule.schedule_id === scheduleIdOf(input.token));
  if (!found) throw new HeldSendError(say('unknown', { token: input.token }));
  if (found.ran_at) throw new HeldSendError(say('too_late', { at: found.ran_at }));
  await automations.removeSchedule({ schedule_id: found.schedule_id });
  return { token: input.token, state: 'cancelled', said: say('cancelled') };
}

/** The route: POST /automations/held {then, undo_seconds?, label?}, GET /automations/held[?token=], POST /automations/held/cancel {token}. */
export async function handleHeldSendRequest(automations, request, options) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/automations/held' && request.method === 'POST') return Response.json(await holdSend(automations, await request.json().catch(() => ({})), options));
    if (url.pathname === '/automations/held' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      return Response.json(token ? await readHeldSend(automations, { token }) : await listHeldSends(automations));
    }
    if (url.pathname === '/automations/held/cancel' && request.method === 'POST') return Response.json(await cancelHeldSend(automations, await request.json().catch(() => ({}))));
    return Response.json({ error: 'Not found.' }, { status: 404 });
  } catch (error) {
    return Response.json({ error: String(error?.message ?? error) }, { status: error instanceof HeldSendError ? 400 : 500 });
  }
}

export const isHeldSendPath = path => path === '/automations/held' || path === '/automations/held/cancel';

const thenSchema = {
  type: 'object',
  description: 'What to send, as set_schedule names it: { "tool_id": "tool:send-an-email", "input": {...} } (a tool from find_tool_for_job) or { "workflow_id": "workflow:...", "input": {...} }',
  properties: { tool_id: { type: 'string' }, workflow_id: { type: 'string' }, input: { type: 'object' } },
};

/** The MCP tools of a held send, in the shape automationTools(call) returns (src/automation-tools.mjs). */
export const heldSendTools = call => [
  { name: 'hold_send', description: `Holds a send for a short time so it can be taken back, then sends it by itself. then is the send exactly as set_schedule names it (a tool such as tool:send-an-email with its input, or a workflow). undo_seconds (${data.least_undo_seconds} to ${data.most_undo_seconds}, ${data.default_undo_seconds} when left out) is how long it waits. Returns a token and the time it goes out; cancel_held_send with the token takes it back until then. The wait is kept by Trillion, so it holds even if you disconnect.`, inputSchema: { type: 'object', required: ['then'], properties: { then: thenSchema, undo_seconds: { type: 'integer', minimum: data.least_undo_seconds, maximum: data.most_undo_seconds }, label: { type: 'string', description: 'What is being sent, in plain words' } } }, run: input => call('/automations/held', input) },
  { name: 'cancel_held_send', description: 'Takes back a held send by its token while it is still waiting, so it is never sent. A send that already went out says when and cannot be taken back.', inputSchema: { type: 'object', required: ['token'], properties: { token: { type: 'string', description: 'The token hold_send returned' } } }, run: input => call('/automations/held/cancel', input) },
  { name: 'list_held_sends', description: 'The held sends waiting to go out or recently sent, soonest first, each with its token and state. Give token to read one. It changes nothing.', inputSchema: { type: 'object', properties: { token: { type: 'string' } } }, run: ({ token } = {}) => call(token ? `/automations/held?token=${encodeURIComponent(token)}` : '/automations/held') },
];

export const heldSendAnnotations = {
  hold_send: { title: 'Hold a send so it can be taken back', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cancel_held_send: { title: 'Take back a held send', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_held_sends: { title: 'List held sends', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
