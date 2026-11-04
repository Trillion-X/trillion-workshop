// tools/media-composition/read-data/session-pairing-tools.mjs
//
// The row over session-pairing.mjs (moved unchanged): one pair-state message applied to one multi-device recording session.
// The session is handed in whole and handed back; a session with only an id and its states starts empty (no primary, no
// devices). Nothing is kept here.
import { apply, newSession } from './session-pairing.mjs';

/** The session the input names, a new one filled in when it carries only id and states. */
export function sessionFromInput(session) {
  if (!session || typeof session.id !== 'string' || !session.id) throw new Error('Give session with its id (and states, the states a device can report).');
  if (!Array.isArray(session.states) || !session.states.length) throw new Error('Give session.states: the states a device can report, the first being where a device starts.');
  return { ...newSession(session.id, session.states), ...session };
}

/** tool:apply-a-pair-state-message: { session, ignored? }; an ignored message leaves the session as it was and says why. */
export const applyPairStateMessage = input => apply(sessionFromInput(input?.session), input?.message);
