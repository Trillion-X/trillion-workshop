// src/list-view-parameters.mjs
//
// Purpose: a saved view whose rule values are given when it is read. "Deals of { owner }" is one view, read for Ana
// and for Ben, instead of a view per person: a rule value written { "parameter": "owner" } (with an optional
// "default") takes the value the reader gives in `parameters` (read_list_view parameters: { owner: "Ana" }).
//
// Non-Negotiable Invariants:
//   1. A parameter is a value, never code: it replaces exactly the object that names it, wherever in a rule's params it is.
//   2. A parameter the view asks for and the reader does not give, with no default, refuses the read naming it
//      (`missing_parameter`); a view is never read with a rule silently dropped.
//   3. The saved view keeps the parameter; a read binds a copy.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isParameter = value => isObject(value) && typeof value.parameter === 'string' && Object.keys(value).every(key => key === 'parameter' || key === 'default');

/** The names of the parameters a view's rules ask for. */
export function parametersOf(view) {
  const found = new Set();
  const walk = node => {
    if (isParameter(node)) { found.add(node.parameter); return; }
    if (Array.isArray(node)) node.forEach(walk);
    else if (isObject(node)) Object.values(node).forEach(walk);
  };
  walk(view?.rules);
  return [...found];
}

/** The view with each parameter in its rules replaced by the value given (or its default). */
export function bindParameters(view, parameters = {}) {
  if (!isObject(parameters) || Object.keys(parameters).length > data.limits.view_parameters) throw say('missing_parameter', { view_id: view.id, parameter: 'parameters' });
  const bind = node => {
    if (isParameter(node)) {
      if (Object.hasOwn(parameters, node.parameter)) return parameters[node.parameter];
      if (Object.hasOwn(node, 'default')) return node.default;
      throw say('missing_parameter', { view_id: view.id, parameter: node.parameter });
    }
    if (Array.isArray(node)) return node.map(bind);
    if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, bind(value)]));
    return node;
  };
  return view.rules ? { ...view, rules: bind(view.rules) } : view;
}
