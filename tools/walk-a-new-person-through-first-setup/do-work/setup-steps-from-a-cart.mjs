// tools/walk-a-new-person-through-first-setup/do-work/setup-steps-from-a-cart.mjs
//
// The setup steps a cart renders to, never written by hand (owner plan D-i: carts are rows, and a journey's setup
// instructions are rendered from its cart). A cart is what fillCart answers: { toolkit, tools, stack? }. Each tool id is
// one step; each slot of the stack is one step, its first pointer the part it takes and the rest its alternatives in
// order. The words are read-data/stack-policy.json `steps`, filled from the pointer's own fields, so the same code renders
// every cart: nothing here names a slot, a vendor, a store or a journey.
//
//   setupSteps(cart, { available })  ->  [ { kind: 'tool', id, status, words }
//                                         | { kind: 'part', slot, id, door, speaks, label?, credential?, alternatives,
//                                             status, words } ]
//
//   status   'ready'           nothing is missing
//            'needs_credential' the part's key is named; the person keeps it in their vault under that name
//            'unavailable'     a tool it names (a tool id, or a pointer's label that is a tool id) is not in `available`
//
// `available` is the tool ids the caller can install (its tools:list); left out, nothing is called unavailable.
// Nothing here reads storage, the network or the clock, and nothing is written.
import policy from '../read-data/stack-policy.json' with { type: 'json' };
import { readStack } from './toolkit-stack.mjs';

const TOOL_ID = /^tool:\S+$/;
const words = policy.steps;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));

/** The ordered setup steps of `cart`: its tools, then its slots in the stack's own order. */
export function setupSteps(cart, { available = null } = {}) {
  if (!cart || typeof cart !== 'object' || !Array.isArray(cart.tools)) throw new Error('A cart is { toolkit, tools, stack? }, as fillCart answers it.');
  const installable = available === null ? null : new Set(available);
  const missing = id => installable !== null && !installable.has(id);
  const tools = cart.tools.map(id => {
    if (typeof id !== 'string' || !TOOL_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a tool id (tool: then the id).`);
    const status = missing(id) ? 'unavailable' : 'ready';
    return { kind: 'tool', id, status, words: fill(status === 'ready' ? words.tool : words.tool_unavailable, { id }) };
  });
  const stack = cart.stack === undefined ? {} : readStack(cart.stack, 'cart.stack');
  const parts = Object.entries(stack).map(([slot, [part, ...others]]) => {
    const values = { slot, ...part, alternatives: others.map(other => other.id).join(', ') };
    const status = TOOL_ID.test(part.label ?? '') && missing(part.label) ? 'unavailable' : part.credential ? 'needs_credential' : 'ready';
    const said = status === 'unavailable' ? [words.part_unavailable]
      : [words.part, ...(part.credential ? [words.credential] : [])];
    if (others.length) said.push(words.alternatives);
    return { kind: 'part', slot, ...part, alternatives: others.map(other => other.id), status, words: said.map(template => fill(template, values)).join(' ') };
  });
  return [...tools, ...parts];
}
