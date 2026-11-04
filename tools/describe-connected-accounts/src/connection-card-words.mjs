// src/connection-card-words.mjs
//
// Purpose: what a connected account's card says in plain words: what Trillion copies from it, what stays live with the
// person's own sign-in, and what Trillion may do with it. The Connections screen (src/account-screens.mjs) shows the
// three as the account's first steps and keeps them in its facts, so the screen, its catalogue filters and an AI reading
// Connections (tool:read-connections) say the same thing.
//
// Non-Negotiable Invariants:
//   1. Only facts already read for the account (shared, carried, the event sources listening to its service, the local
//      sign-in copy, can_send, capability choices) decide the words; nothing is claimed that no fact shows.
//   2. Every sentence is a row of src/connection-card-words.json, chosen by its `when` facts; no service is named here.
//
//   connectionCardFacts(item, { arriving, localCopy, capabilities }) → the facts the rows read
//   connectionCardWords(facts) → { copied, live, allowed } sentences
//   connectionCardSteps(words) → guide steps [{ title, body }]
//   TOOL_SERVER_WORDS: what a found tool server row says (src/connector-screen.mjs)
import WORDS from './connection-card-words.json' with { type: 'json' };

const PARTS = ['copied', 'live', 'allowed'];
const listed = labels => (labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0] ?? '');
const filled = value => (Array.isArray(value) ? value.length > 0 : Boolean(value));
const holds = (row, facts) => Object.entries(row.when ?? {}).every(([name, wanted]) => filled(facts[name]) === wanted);
const fill = (template, facts) => template.replace(/\{(\w+)\}/g, (_, name) => (Array.isArray(facts[name]) ? listed(facts[name]) : String(facts[name] ?? '')));

/** The facts the words read for one account: `arriving` the labels of event sources listening to its service,
 *  `localCopy` whether the person's computers may keep its sign-in, `capabilities` the service's declared capabilities
 *  ({ id, label }) whose choices on the account say on or off (a capability with no choice is on). */
export function connectionCardFacts(item, { arriving = [], localCopy = false, capabilities = [] } = {}) {
  const shared = item.visibility === 'shared';
  const choices = item.capabilityChoices ?? {};
  const named = capabilities.filter(capability => typeof capability?.label === 'string' && capability.label.trim());
  return {
    service: item.service ?? item.vendor ?? '',
    account: item.account_label ?? item.service ?? '',
    shared,
    carried: Boolean(item.carried_by),
    arriving: shared ? [] : arriving,
    local_copy: !shared && localCopy,
    can_send: item.can_send === true,
    on: named.filter(capability => choices[capability.id] !== 'disabled').map(capability => capability.label),
    off: named.filter(capability => choices[capability.id] === 'disabled').map(capability => capability.label),
  };
}

/** The three sentences for an account's facts. */
export function connectionCardWords(facts) {
  const say = rows => { const row = rows.find(candidate => holds(candidate, facts)); return row ? fill(row.say, facts) : ''; };
  const also = rows => rows.filter(row => holds(row, facts)).map(row => fill(row.say, facts));
  return Object.fromEntries(PARTS.map(part => [part, [say(WORDS[part]), ...also(WORDS[`${part}_also`] ?? [])].filter(Boolean).join(' ')]));
}

/** What a found tool server's row says before it is added: it runs live, nothing is copied ahead of time. */
export const TOOL_SERVER_WORDS = WORDS.tool_server;

/** The sentences as the guide's steps, each under its title. */
export const connectionCardSteps = words => PARTS.filter(part => words[part]).map(part => ({ title: WORDS.titles[part], body: words[part] }));
