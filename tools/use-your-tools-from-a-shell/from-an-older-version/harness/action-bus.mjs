// harness/action-bus.mjs
//
// Purpose
//   A command-line road to this computer's actions for an AI that can run a shell but has no MCP connection of its
//   own: `trillion action SERVICE ACTION 'JSON'` becomes one run_tool call on the person's account, naming the
//   Workshop tool the registry row names. The line is only parsed here; there is no program behind the service names.
//
// Non-negotiable invariants
//   1. The registry (action-bus.json) is the only list reachable: a service or action not in it is refused in words
//      that list what is, and nothing in a line ever names a tool id, a module or a path.
//   2. The input is one JSON object (or nothing, meaning {}); anything else is refused before any call is made.
//   3. This file runs nothing and holds no key: the caller sends the call it returns, so every check the tool and the
//      account make applies exactly as for any connected AI.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const actionRegistry = () => JSON.parse(readFileSync(join(HERE, 'action-bus.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const known = object => Object.keys(object).join(', ');

export class ActionRefused extends Error {}

/**
 * `words` is what follows `trillion action`: [service, action, json?]. Returns { tool, arguments, idempotent } for the
 * run_tool call, or throws ActionRefused with the words to say.
 */
export function actionCall(words, registry = actionRegistry()) {
  const [service, action, raw] = words;
  if (!service || !action) throw new ActionRefused(registry.words.say_the_service);
  if (!Object.hasOwn(registry.services, service)) throw new ActionRefused(fill(registry.words.unknown_service, { service, services: known(registry.services) }));
  const actions = registry.services[service].actions;
  if (!Object.hasOwn(actions, action)) throw new ActionRefused(fill(registry.words.unknown_action, { service, action, actions: known(actions) }));
  let input = {};
  if (raw !== undefined) {
    try { input = JSON.parse(raw); } catch { throw new ActionRefused(registry.words.not_an_object); }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ActionRefused(registry.words.not_an_object);
  }
  return { tool: 'run_tool', arguments: { tool_id: actions[action].tool_id, input }, idempotent: false };
}

/** The list `trillion actions` prints: one line per action with what it does. */
export function actionList(registry = actionRegistry()) {
  return Object.entries(registry.services).flatMap(([service, row]) =>
    Object.entries(row.actions).map(([action, entry]) => `${service} ${action}  ${entry.what}`)).join('\n');
}
