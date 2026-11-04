// src/session-pairing.mjs
//
// PURPOSE
//   Several devices taking part in one session (cameras, a watch, a remote control) share one session id, exactly one is primary, and
//   each sends an explicit pair-state message. A message for another session, from an unknown device, or that would break the rules
//   is logged and ignored; it never changes the session.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure state machine: apply(session, message) → { session, ignored? } never mutates its input.
//   2. Messages carry `session`, `device` and a `type`; a `state` message names a state from the session's own `states` DATA; a wrong session id is ignored with a reason.
//   3. Exactly one primary: the first device to join as primary holds it; a second primary join, or the primary leaving,
//      is explicit (`handover`), never silent.
//
const ignore = (session, reason, message) => ({ session, ignored: { reason, message } });

export const newSession = (id, states) => ({ id, states, primary: null, devices: {} });

export function apply(session, message) {
  if (message?.session !== session.id) return ignore(session, 'other_session', message);
  if (typeof message.device !== 'string' || !message.device) return ignore(session, 'no_device', message);
  if (message.type === 'handover') {
    if (!session.devices[message.device]) return ignore(session, 'unknown_device', message);
    if (session.primary !== message.from) return ignore(session, 'not_primary', message);
    return { session: { ...session, primary: message.device } };
  }
  if (message.type === 'join') {
    if (session.devices[message.device]) return ignore(session, 'already_joined', message);
    if (message.role === 'primary' && session.primary) return ignore(session, 'primary_taken', message);
    return { session: { ...session, primary: message.role === 'primary' ? message.device : session.primary,
      devices: { ...session.devices, [message.device]: { state: session.states[0], role: message.role ?? 'secondary' } } } };
  }
  if (message.type === 'leave') {
    if (!session.devices[message.device]) return ignore(session, 'unknown_device', message);
    const { [message.device]: _left, ...devices } = session.devices;
    return { session: { ...session, devices, primary: session.primary === message.device ? null : session.primary } };
  }
  if (message.type === 'state') {
    if (!session.devices[message.device]) return ignore(session, 'unknown_device', message);
    if (!session.states.includes(message.state)) return ignore(session, 'unknown_state', message);
    return { session: { ...session, devices: { ...session.devices, [message.device]: { ...session.devices[message.device], state: message.state } } } };
  }
  return ignore(session, 'unknown_type', message);
}
