// What one sign-in may reach: the person's private Trillion, the rooms of some of their pursuits, or both.
//
// Purpose
//   An agent can be held to the private Trillion only, to the rooms of all or some pursuits (a room is where a
//   pursuit's people and shared things are, src/pursuit-rooms.mjs; `spaces` names rooms by id). The reach belongs to
//   the credential the agent signed in with (a personal key made with a reach), so it is checked by the service on
//   every request and an agent cannot widen it by what it says about itself.
//
// Shape (machine-readable, never a string code): { private: boolean, spaces: "all" | [space ids] }.
//   { private: true,  spaces: "all" }   the whole account: every sign-in made before reaches existed, and every app
//   { private: true,  spaces: [] }      private only
//   { private: false, spaces: "all" }   every space the person is in, nothing private
//   { private: false, spaces: [id] }    one named space, nothing else
//
// Non-negotiable invariants
//   1. A reach is set by the Worker from the credential, never read from the request.
//   2. A credential can only make keys that reach no further than itself.
//   3. Without the private reach, a request can reach spaces and nothing else: no files, decisions, messages,
//      pursuits, contacts, network or account settings.
//
import reachChoices from '../../shared-code/src/reach-choices.json' with { type: 'json' };

/** The choices the consent page offers, in order; the first is the default (the whole account). */
export const REACH_CHOICES = reachChoices.choices;
export const DEFAULT_REACH_CHOICE = REACH_CHOICES[0].id;

export const FULL_REACH = Object.freeze({ private: true, spaces: 'all' });

/** A reach as given (by a person making a key), checked into its one shape. */
export function reachFrom(input) {
  if (input === undefined || input === null) return FULL_REACH;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('reach is { private: true or false, spaces: "all" or a list of space ids }.');
  const spaces = input.spaces === undefined || input.spaces === 'all' ? 'all' : Array.isArray(input.spaces) ? [...new Set(input.spaces.map(String))] : null;
  if (spaces === null || (Array.isArray(spaces) && spaces.some(id => !id))) throw new Error('reach.spaces is "all" or a list of space ids.');
  if (input.private === undefined) throw new Error('reach.private is needed: true to reach the private Trillion, false to reach spaces only.');
  const reach = { private: input.private === true, spaces };
  if (!reach.private && Array.isArray(spaces) && !spaces.length) throw new Error('A reach with nothing private and no pursuits reaches nothing.');
  return reach;
}

/** The reach a signed-in request carries: the one its credential was made with, else the whole account. */
export const reachOfProps = props => (props?.reach ? reachFrom(props.reach) : FULL_REACH);

/** Whether `asked` reaches no further than `held`. */
export function within(asked, held) {
  if (asked.private && !held.private) return false;
  if (held.spaces === 'all') return true;
  return asked.spaces !== 'all' && asked.spaces.every(id => held.spaces.includes(id));
}

/** Whether a store path (as the MCP tools and /mcp/api name it) may be reached with this reach. */
// Space-only requests go through /spaces/<id>, where current membership and
// resource grants are checked. A caller-supplied context never widens reach.
// A pursuit's room is reached through its pursuit too: the list (filtered to the rooms this reach holds) and opening
// a reached pursuit's room (src/pursuit-rooms.mjs answers both, and refuses the rest without the private reach).
export const pathAllowed = (reach, path) => reach.private
  || path === '/spaces' || path.startsWith('/spaces/') || path.startsWith('/spaces?')
  || path === '/pursuits' || path.startsWith('/pursuits?') || /^\/pursuits\/[^/?]+\/room$/.test(path);

/** What a request outside its reach is told. */
export const REACH_REFUSED = 'This sign-in reaches only the pursuits it was given, so it cannot reach anything else in your Trillion.';

export const isFull = reach => reach.private && reach.spaces === 'all';

/** What the person picked on the consent page for an AI app that is connecting, as a reach. `spaces` is the list of
 *  space ids picked when the choice's row says `spaces: "picked"`. */
export function reachForChoice(choice, spaces = []) {
  const row = REACH_CHOICES.find(item => item.id === (choice ?? DEFAULT_REACH_CHOICE));
  if (!row) throw new Error('Choose what the app may reach.');
  if (row.spaces === 'picked' && !(Array.isArray(spaces) && spaces.length)) throw new Error('Pick at least one pursuit.');
  return reachFrom({ private: row.private, spaces: row.spaces === 'picked' ? spaces : row.spaces });
}

/** Whether a choice asks the person to pick spaces after signing in. */
export const choicePicksSpaces = choice => REACH_CHOICES.find(item => item.id === choice)?.spaces === 'picked';

/** The sign-in props a reach adds: none for the whole account (every sign-in made before reaches existed reads so). */
export const reachProps = reach => (isFull(reach) ? {} : { reach });
