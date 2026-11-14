// src/screen-spec.mjs
//
// PURPOSE
//   A screen made of shared parts, sent by an AI as it writes it. The screen is a spec: { root, elements, state, reads }.
//   `elements` is a flat map from a key the AI chooses to { type, props, children, on, visible, repeat }, where `type` is
//   a shared part (parts/ui/declared-props.json: its export, the props it declares, its events), `children` are keys of
//   other elements, `on` binds a part's event to an action (a request the screen declares, the same declarations a
//   saved module screen makes: parts/ui/show/isolated-module-surface/module-surface-requests.mjs, or setState), and a prop
//   may read the screen's state ({"$state": "/path"}), a repeated item ({"$item": "field"}), its index ({"$index": true}),
//   words with state in them ({"$template": "Hello ${/name}"}) or a choice ({"$cond": ..., "$then": ..., "$else": ...});
//   {"$bindState": "/path"} and {"$bindItem": "field"} read a value and write it back when the part reports a change.
//   `reads` fill state from declared GET requests ({ "/notes": { "request": "notes", "pick": "/rows" } }).
//
//   The AI sends the spec as lines, each an RFC 6902 change (or a list of them) to the spec, root first. This file turns
//   lines into the spec as they arrive (specStream), checks every element against its part's declared props and fixes
//   what it can (checkElement, checkSpec), and resolves bound values for drawing (resolveValue, conditionHolds). It is
//   pure: no DOM, no I/O, so the Worker checks a screen with exactly what the page draws it with.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no part, prop or request is named here. Parts are rows of parts/ui/declared-props.json; requests are the
//      screen's own declarations. A new part is one DATA row.
//   2. A bad line or a bad element never stops the rest: a line that cannot apply is left out whole and said; an element
//      that cannot be drawn is marked unusable (the page draws its fallback in its place) and said.
//   3. Unchanged elements keep their identity across lines (src/view-patch.mjs applyPatch copies only the path a change
//      touches), so a page redraws only what a line changed.
//   4. Nothing here runs code: a spec is data; bound values are looked up, never evaluated.
//   5. Every limit and every word is DATA (./screen-spec.json).

import settings from 'trillion-workshop/tools/build-a-screen-from-patches/read-data/screen-spec.json' with { type: 'json' };
import declared from 'trillion-workshop/tools/ui/declared-props.json' with { type: 'json' };
import { applyPatch } from './view-patch.mjs';

const { limits, words } = settings;
/** The screen kind of a screen made of parts (src/workspace/tool-screen.tsx SHOWS). */
export const PARTS_SCREEN = 'parts';
/** The licence a screen-only tool is saved with when it names none (it holds no code of anyone's). */
export const SCREEN_ONLY_LICENCE = settings.screen_only_licence;
export const screenSpecWords = words;
/** Words an AI reads about parts screens. */
export const screenSpecAi = settings.ai;
export const screenSpecLimits = limits;
/** The parts a screen may use, by export name (open DATA). */
export const declaredParts = declared.parts;

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** What an AI reads about making a parts screen: the guide's words with every declared part, its props and events. */
export const partsGuide = () => settings.ai.guide.replace('{parts}', Object.entries(declaredParts).map(([name, part]) => {
  const extra = [part.events ? `on ${Object.keys(part.events).join('/')}` : '', part.children ? 'children' : ''].filter(Boolean);
  return `${name}(${[Object.keys(part.props ?? {}).join(', '), ...extra].join('; ')})`;
}).join(' '));
/** Whether a tool row is a screen by itself: a parts screen with nothing to run. */
export const screenOnly = row => object(row) && row.invoke === undefined && object(row.screen) && row.screen.kind === PARTS_SCREEN;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const say = (template, values = {}) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const shown = value => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));
const ROOTS = new Set(['root', 'elements', 'state', 'reads']);
const OPS = new Set(['add', 'replace', 'remove']);
const MOVABLE = ['on', 'visible', 'repeat', 'children'];
const DYNAMIC = ['$state', '$item', '$index', '$bindState', '$bindItem', '$template', '$cond', '$event'];

const unpointer = path => (path === '' ? [] : String(path).slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')));
const pointer = parts => parts.map(part => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** The value at a JSON pointer in `value`, or undefined. Only the value's own fields are read, never what every object
 * inherits (`/constructor` is nothing). */
export function pointerGet(value, path) {
  if (typeof path !== 'string') return undefined;
  let at = value;
  for (const part of unpointer(path.startsWith('/') || path === '' ? path : `/${path}`)) {
    if (at === null || typeof at !== 'object' || !own(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

// The adds that make every missing parent of `path` an object first, so {"op":"add","path":"/state/a/b"} needs no
// earlier line for /state/a.
function withParents(model, op) {
  if (op.op !== 'add') return [op];
  const parts = unpointer(op.path);
  const made = [];
  let at = model;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = at === null || typeof at !== 'object' ? undefined : at[parts[index]];
    if (next === undefined) {
      made.push({ op: 'add', path: pointer(parts.slice(0, index + 1)), value: {} });
      at = {};
    } else at = next;
  }
  return [...made, op];
}

/** `value` at `path` in `state`, as a new state (the old one unchanged; untouched branches keep their identity). */
export function pointerSet(state, path, value) {
  const base = object(state) ? state : {};
  return applyPatch(base, withParents(base, { op: 'add', path, value }));
}

// What a line's ops change: 'root', 'state', 'reads', or 'elements/<key>' (every element: 'elements').
function changedBy(ops) {
  const changed = new Set();
  for (const op of ops) {
    const [first, second] = unpointer(op.path);
    changed.add(first === 'elements' && second !== undefined ? `elements/${second}` : first);
  }
  return changed;
}

// The ops one parsed line carries, or a reason it carries none. A whole spec object on one line replaces each of its
// parts, so an AI that sends the spec at once is taken too.
function opsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (object(parsed) && typeof parsed.op === 'string') return [parsed];
  if (object(parsed) && Object.keys(parsed).some(key => ROOTS.has(key))) {
    return Object.entries(parsed).filter(([key]) => ROOTS.has(key)).map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
  }
  return null;
}

function lineProblem(ops, number) {
  if (!ops) return say(words.bad_line, { line: number, reason: 'it is neither a change, a list of changes nor a screen.' });
  if (ops.length > limits.ops_per_line) return say(words.bad_line, { line: number, reason: `it holds more than ${limits.ops_per_line} changes.` });
  for (const op of ops) {
    if (!object(op) || typeof op.path !== 'string' || (op.path !== '' && !op.path.startsWith('/'))) return say(words.bad_line, { line: number, reason: 'a change needs an op and a path that starts with /.' });
    if (!OPS.has(op.op)) return say(words.bad_op, { line: number, op: shown(op.op) });
    const [first] = unpointer(op.path);
    if (!ROOTS.has(first)) return say(words.bad_path, { line: number, path: op.path || '/' });
    if (op.op !== 'remove' && !own(op, 'value')) return say(words.bad_line, { line: number, reason: `${op.op} ${op.path} has no value.` });
  }
  return null;
}

const emptySpec = () => ({ root: null, elements: {}, state: {}, reads: {} });

/**
 * Lines into a spec as they arrive. `push(text)` takes the WHOLE stream so far (an app hands the growing arguments of
 * one call, never a part of them) and applies every line it completes; `end(text)` also applies a last line with no line
 * break. A text that does not continue what was taken starts the screen again. Each answers { spec, changed, said,
 * restarted }: `changed` names what the new lines touched ('root', 'state', 'reads', 'elements/<key>').
 */
export function specStream() {
  let spec = emptySpec();
  let taken = '';
  let lines = 0;
  let total = false;
  const take = (text, finished) => {
    const said = [];
    const changed = new Set();
    let restarted = false;
    let whole = typeof text === 'string' ? text : '';
    if (whole.length > limits.stream_chars) whole = whole.slice(0, limits.stream_chars);
    if (!whole.startsWith(taken)) { spec = emptySpec(); taken = ''; lines = 0; total = false; restarted = true; changed.add('root'); changed.add('elements'); changed.add('state'); changed.add('reads'); }
    const rest = whole.slice(taken.length);
    const end = finished ? rest.length : rest.lastIndexOf('\n') + 1;
    if (end <= 0) return { spec, changed, said, restarted };
    taken += rest.slice(0, end);
    for (const line of rest.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      if (lines > limits.lines) { if (!total) said.push(say(words.too_many_lines, { most: limits.lines })); total = true; continue; }
      if (line.length > limits.line_chars) { said.push(say(words.too_long_line, { line: lines, most: limits.line_chars })); continue; }
      let parsed;
      try { parsed = JSON.parse(line); } catch { said.push(say(words.bad_line, { line: lines, reason: 'it is not complete JSON.' })); continue; }
      const ops = opsOf(parsed);
      const problem = lineProblem(ops, lines);
      if (problem) { said.push(problem); continue; }
      let next = spec;
      try {
        for (const op of ops) next = applyPatch(next, withParents(next, op));
      } catch (error) { said.push(say(words.bad_line, { line: lines, reason: String(error?.message ?? error) })); continue; }
      if (!object(next.elements)) { said.push(say(words.bad_line, { line: lines, reason: 'elements must be an object of elements by key.' })); continue; }
      if (Object.keys(next.elements).length > limits.elements) { said.push(say(words.too_many_elements, { most: limits.elements })); continue; }
      spec = next;
      for (const one of changedBy(ops)) changed.add(one);
    }
    return { spec, changed, said, restarted };
  };
  return { push: text => take(text, false), end: text => take(text, true), spec: () => spec };
}

/** The spec a whole stream of lines makes, with what was said about its lines. */
export function specFromText(text) {
  const { spec, said } = specStream().end(text);
  return { spec, said };
}

const isDynamic = value => object(value) && DYNAMIC.some(key => own(value, key));

// One value checked against a declared prop schema: { value, was? } when it fits or was fixed, { problem } when not.
function checkValue(value, schema, depth = 0) {
  if (depth > limits.depth) return { problem: 'is nested too deeply' };
  if (!object(schema)) return { value };
  if (Array.isArray(schema.enum)) {
    if (schema.enum.includes(value)) return { value };
    const text = String(value ?? '').trim().toLowerCase();
    const found = schema.enum.find(option => String(option).toLowerCase() === text);
    return found !== undefined ? { value: found, was: value } : { problem: `is not one of ${schema.enum.join(', ')}` };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    let number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(number)) return { problem: 'must be a number' };
    if (schema.type === 'integer') number = Math.round(number);
    if (Number.isFinite(schema.minimum)) number = Math.max(schema.minimum, number);
    if (Number.isFinite(schema.maximum)) number = Math.min(schema.maximum, number);
    return number === value ? { value } : { value: number, was: value };
  }
  if (schema.type === 'boolean') {
    if (typeof value === 'boolean') return { value };
    if (value === 'true' || value === 1) return { value: true, was: value };
    if (value === 'false' || value === 0) return { value: false, was: value };
    return { problem: 'must be true or false' };
  }
  if (schema.type === 'string') {
    let text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
    if (text === null) return { problem: 'must be words' };
    if (Number.isFinite(schema.maxLength) && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
    return text === value ? { value } : { value: text, was: value };
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return { problem: 'must be a list' };
    let fixed = false;
    const items = [];
    for (const item of Number.isFinite(schema.maxItems) ? value.slice(0, schema.maxItems) : value) {
      const checked = isDynamic(item) ? { value: item } : checkValue(item, schema.items, depth + 1);
      if (checked.problem) { fixed = true; continue; }
      if (own(checked, 'was')) fixed = true;
      items.push(checked.value);
    }
    if (items.length !== value.length) fixed = true;
    return fixed ? { value: items, was: value } : { value };
  }
  if (schema.type === 'object') {
    if (!object(value)) return { problem: 'must be an object' };
    if (!object(schema.properties)) return { value };
    let fixed = false;
    const kept = {};
    for (const [name, one] of Object.entries(value)) {
      if (!own(schema.properties, name)) { fixed = true; continue; }
      const checked = isDynamic(one) ? { value: one } : checkValue(one, schema.properties[name], depth + 1);
      if (checked.problem) { fixed = true; continue; }
      if (own(checked, 'was')) fixed = true;
      kept[name] = checked.value;
    }
    return fixed ? { value: kept, was: value } : { value };
  }
  return { value };
}

/** Whether a binding names an action a screen can run: setState, or one of its declared requests. */
const actionKnown = (action, requests) => action === 'setState' || (object(requests) && typeof action === 'string' && own(requests, action));

/**
 * One element checked against its part's declared props, fixed where it can be. Answers { element, usable, fixes,
 * problems }: an unusable element is drawn as the fallback in its place, and its problems say why.
 * `resolved: true` checks props already resolved for drawing (no bound values left).
 */
export function checkElement(key, element, { requests = {}, parts = declaredParts, resolved = false } = {}) {
  const fixes = [];
  const problems = [];
  if (!object(element)) return { element: null, usable: false, fixes, problems: [say(words.not_element, { key })] };
  let next = { ...element, props: object(element.props) ? { ...element.props } : {} };
  for (const field of MOVABLE) {
    if (own(next.props, field) && !own(next, field)) {
      next[field] = next.props[field];
      delete next.props[field];
      fixes.push(say(words.moved_field, { key, field }));
    }
  }
  let type = typeof next.type === 'string' ? next.type : '';
  if (!own(parts, type)) {
    const found = Object.keys(parts).find(name => name.toLowerCase() === type.trim().toLowerCase());
    if (found) { fixes.push(say(words.fixed_prop, { key, prop: 'type', was: shown(type), now: shown(found) })); type = found; next.type = found; }
    else return { element: next, usable: false, fixes, problems: [say(words.unknown_part, { key, type, parts: Object.keys(parts).join(', ') })] };
  }
  const part = parts[type];
  const schemas = object(part.props) ? part.props : {};
  if (next.children !== undefined) {
    const children = Array.isArray(next.children) ? next.children.filter(child => typeof child === 'string') : [];
    if (part.children !== true && children.length) { fixes.push(say(words.no_children, { key, type })); next.children = []; }
    else if (!Array.isArray(next.children) || children.length !== next.children.length) next.children = children;
  }
  for (const [name, value] of Object.entries(next.props)) {
    if (!own(schemas, name)) { delete next.props[name]; fixes.push(say(words.dropped_prop, { key, type, prop: name })); continue; }
    if (!resolved && isDynamic(value)) continue;
    const checked = checkValue(value, schemas[name]);
    if (checked.problem) { delete next.props[name]; fixes.push(say(words.unfixable_prop, { key, prop: name, problem: checked.problem })); continue; }
    if (own(checked, 'was')) { next.props[name] = checked.value; fixes.push(say(words.fixed_prop, { key, prop: name, was: shown(checked.was), now: shown(checked.value) })); }
  }
  for (const name of part.required ?? []) if (next.props[name] === undefined) problems.push(say(words.missing_prop, { key, type, prop: name }));
  if (next.on !== undefined) {
    const events = object(part.events) ? part.events : {};
    const on = {};
    for (const [event, binding] of Object.entries(object(next.on) ? next.on : {})) {
      if (!own(events, event)) { fixes.push(say(words.unknown_event, { key, type, event, events: Object.keys(events).join(', ') || '-' })); continue; }
      const bindings = (Array.isArray(binding) ? binding : [binding]).filter(one => {
        const known = object(one) && actionKnown(one.action, requests);
        if (!known) fixes.push(say(words.unknown_action, { key, event, action: object(one) ? one.action : one }));
        return known;
      });
      if (bindings.length) on[event] = bindings;
    }
    next.on = on;
  }
  return { element: next, usable: problems.length === 0, fixes, problems };
}

const declaredGet = (requests, name) => object(requests) && own(requests, name) && object(requests[name]) && requests[name].method === 'GET';

/**
 * The whole spec checked: every element through checkElement, reads against the declared GET requests, and, once the
 * stream is `complete`, children that were never sent left out and the root required. Answers { spec, fixes, problems }.
 */
export function checkSpec(spec, { requests = {}, parts = declaredParts, complete = true } = {}) {
  const fixes = [];
  const problems = [];
  const elements = {};
  const source = object(spec?.elements) ? spec.elements : {};
  for (const [key, element] of Object.entries(source)) {
    const checked = checkElement(key, element, { requests, parts });
    fixes.push(...checked.fixes);
    problems.push(...checked.problems);
    if (checked.element) elements[key] = checked.element;
  }
  if (complete) {
    for (const [key, element] of Object.entries(elements)) {
      if (!Array.isArray(element.children)) continue;
      const kept = element.children.filter(child => own(elements, child));
      for (const child of element.children) if (!own(elements, child)) fixes.push(say(words.dangling_child, { key, child }));
      if (kept.length !== element.children.length) elements[key] = { ...element, children: kept };
    }
  }
  const reads = {};
  for (const [path, read] of Object.entries(object(spec?.reads) ? spec.reads : {}).slice(0, limits.reads)) {
    if (object(read) && declaredGet(requests, read.request)) reads[path] = read;
    else fixes.push(say(words.bad_read, { path, request: object(read) ? read.request : read }));
  }
  const root = typeof spec?.root === 'string' ? spec.root : null;
  if (complete && !root) problems.push(words.no_root);
  else if (complete && !own(elements, root)) problems.push(say(words.root_missing, { root }));
  return { spec: { root, elements, state: object(spec?.state) ? spec.state : {}, reads }, fixes, problems };
}

/** Whether a visibility condition holds in `scope` ({ state, item, index }): true/false, one condition
 * ({ $state | $item | $index, eq | neq | gt | gte | lt | lte, not }), a list (all), { $and } or { $or }. */
export function conditionHolds(condition, scope, depth = 0) {
  if (condition === undefined) return true;
  if (typeof condition === 'boolean') return condition;
  if (depth > limits.depth) return false;
  if (Array.isArray(condition)) return condition.every(one => conditionHolds(one, scope, depth + 1));
  if (!object(condition)) return Boolean(condition);
  if (Array.isArray(condition.$and)) return condition.$and.every(one => conditionHolds(one, scope, depth + 1));
  if (Array.isArray(condition.$or)) return condition.$or.some(one => conditionHolds(one, scope, depth + 1));
  const value = own(condition, '$state') ? pointerGet(scope.state, condition.$state)
    : own(condition, '$item') ? (condition.$item === '' ? scope.item : pointerGet(scope.item, condition.$item))
      : own(condition, '$index') ? scope.index : undefined;
  const side = given => (object(given) && own(given, '$state') ? pointerGet(scope.state, given.$state) : given);
  const holds = own(condition, 'eq') ? JSON.stringify(value) === JSON.stringify(side(condition.eq))
    : own(condition, 'neq') ? JSON.stringify(value) !== JSON.stringify(side(condition.neq))
      : own(condition, 'gt') ? Number(value) > Number(side(condition.gt))
        : own(condition, 'gte') ? Number(value) >= Number(side(condition.gte))
          : own(condition, 'lt') ? Number(value) < Number(side(condition.lt))
            : own(condition, 'lte') ? Number(value) <= Number(side(condition.lte))
              : Array.isArray(value) ? value.length > 0 : Boolean(value);
  return condition.not === true ? !holds : holds;
}

const itemValue = (scope, field) => (field === '' || field === undefined ? scope.item : pointerGet(scope.item, field));

/** A prop's value for drawing in `scope` ({ state, item, index, event }): bound values looked up, the rest as given. */
export function resolveValue(value, scope, depth = 0) {
  if (depth > limits.depth) return undefined;
  if (Array.isArray(value)) return value.map(one => resolveValue(one, scope, depth + 1));
  if (!object(value)) return value;
  if (own(value, '$state')) return pointerGet(scope.state, value.$state);
  if (own(value, '$bindState')) return pointerGet(scope.state, value.$bindState);
  if (own(value, '$item')) return itemValue(scope, value.$item);
  if (own(value, '$bindItem')) return itemValue(scope, value.$bindItem);
  if (own(value, '$index')) return scope.index;
  if (own(value, '$event')) return scope.event;
  if (own(value, '$template')) {
    return String(value.$template).slice(0, limits.template_chars).replace(/\$\{([^}]*)\}/g, (_, path) => {
      const found = pointerGet(scope.state, path.trim());
      return found === undefined || found === null ? '' : typeof found === 'object' ? JSON.stringify(found) : String(found);
    });
  }
  if (own(value, '$cond')) return resolveValue(conditionHolds(value.$cond, scope, depth + 1) ? value.$then : value.$else, scope, depth + 1);
  return Object.fromEntries(Object.entries(value).map(([name, one]) => [name, resolveValue(one, scope, depth + 1)]));
}

/** Where a bound prop writes its new value in state: { "$bindState": path } is that path; { "$bindItem": field } is the
 * field of the repeated item at `scope.itemPath`. Null for a prop that is not bound. */
export function boundPath(value, scope) {
  if (object(value) && typeof value.$bindState === 'string') return value.$bindState;
  if (object(value) && typeof value.$bindItem === 'string' && typeof scope.itemPath === 'string') return value.$bindItem === '' ? scope.itemPath : `${scope.itemPath}/${value.$bindItem.replace(/^\//, '')}`;
  return null;
}

/** Whether an element reads the screen's state anywhere (so it draws again when state changes). */
export function readsState(element) {
  return JSON.stringify(element ?? null).match(/"\$(state|bindState|template|cond|bindItem|item|index)"/) !== null || element?.repeat !== undefined || element?.visible !== undefined;
}
