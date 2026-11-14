// Read-only presentation of the existing EEAF facts/parts/holders contract.
// Array positions and record identities remain exact. A stored boolean, relation or
// anchor is never promoted to an observed action or a verified outcome.
import momentWords from './say-about-this.json' with { type: 'json' };
import scopeData from '../record-scope.json' with { type: 'json' };
import reactions from '../reactions.json' with { type: 'json' };
import { refOf } from '../record-reference.mjs';
import { partFrom } from '../responses.mjs';
import { placeOfAddress } from './addresses.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length ? value : null;
const pathKey = path => JSON.stringify(path);
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const readable = value => String(value).replace(/[_-]+/g, ' ');
const samePath = (left, right) => left.length === right.length && left.every((key, index) => key === right[index]);

/** Current typed reads and the offered screens' opens_kinds/route DATA produce
 * destinations without inferring a type from an id. An explicit owner target
 * takes precedence and cannot fall back after a conflict. Its inputs must agree
 * with the cold address, so opening in place and opening a new tab keep scope. */
export function modelReferenceTarget(reference, named, screens, origin) {
  if (!Array.isArray(screens) || !object(named) || (named.ref ?? named.id) !== reference || named.unavailable || named.missing
      || named.unresolved || named.version !== 'current') return null;
  let supplied = named.open ?? named.target;
  if (supplied === undefined && named.open_href === undefined) {
    if (typeof named.id !== 'string' || !named.id || typeof named.type !== 'string') return null;
    const owners = screens.filter(row => object(row) && Array.isArray(row.opens_kinds) && row.opens_kinds.includes(named.type)
      && typeof row.id === 'string' && row.id && typeof row.route_prefix === 'string'
      && typeof row.route_input === 'string' && row.route_input);
    if (owners.length !== 1) return null;
    const owner = owners[0];
    supplied = { screen: owner.id, input: { [owner.route_input]: named.id }, href: owner.route_prefix + encodeURIComponent(named.id) };
  }
  if (supplied !== undefined && (!object(supplied) || !object(supplied.input))) return null;
  const href = supplied?.href ?? named.open_href;
  if (typeof href !== 'string' || !href || /[\\\x00-\x1f\x7f]/.test(href)) return null;
  let address;
  try {
    address = new URL(href, origin);
    if (address.origin !== new URL(origin).origin || address.username || address.password) return null;
  } catch { return null; }
  let place;
  try { place = placeOfAddress(screens, address.href, origin); } catch { return null; }
  if (!place || supplied && (supplied.screen !== place.row.id
      || Object.entries(supplied.input).some(([key, value]) => !Object.hasOwn(place.input, key)
        || typeof value !== 'string' || value !== place.input[key]))) return null;
  return { screen: place.row.id, input: place.input, href: address.pathname + address.search + address.hash };
}

/** Restore only an addressed part, within its existing owner's size limit. Own
 *  properties avoid prototype interpretation, including for unfamiliar locators. */
function partAt(facts, path) {
  const prefix = [...path, 'part'];
  const under = facts.filter(fact => samePath(fact.path.slice(0, prefix.length), prefix));
  if (!under.length) return undefined;
  const whole = under.find(fact => fact.path.length === prefix.length);
  if (whole) return whole.value == null ? undefined : modelPart(whole.value);
  const part = Object.create(null);
  for (const fact of under) {
    const rest = fact.path.slice(prefix.length);
    if (!rest.length || rest.length > 64 || rest.some(key => typeof key === 'number'
      ? !Number.isSafeInteger(key) || key < 0 || key > reactions.limits.anchor_bytes : typeof key !== 'string')) return null;
    let value = part;
    for (let index = 0; index < rest.length; index++) {
      const key = rest[index];
      if (index === rest.length - 1) Object.defineProperty(value, key, { value: fact.value, enumerable: true, configurable: true, writable: true });
      else {
        if (!Object.hasOwn(value, key)) Object.defineProperty(value, key, { value: typeof rest[index + 1] === 'number' ? [] : Object.create(null), enumerable: true });
        value = value[key];
        if (value === null || typeof value !== 'object') return null;
      }
    }
  }
  return modelPart(part);
}

/** The same validator reads a stored locator and a cold link's JSON input. */
export function modelPart(value) {
  try {
    if (typeof value === 'string') {
      if (value.length > reactions.limits.anchor_bytes) return null;
      value = JSON.parse(value);
    }
    return partFrom(value);
  } catch { return null; }
}

export function modelLabels(model = {}) {
  const labels = Array.isArray(model.labels) ? model.labels : Object.values(model.labels ?? {});
  const named = new Map(labels.filter(label => text(label?.ref ?? label?.id)).map(label => [label.ref ?? label.id, label]));
  // An explicit anchor is navigable even when its owner has supplied no name.
  // Keep its exact identity; neither infer a label nor turn arbitrary text into a reference.
  for (const anchor of modelAnchors(model)) if (!named.has(anchor.record)) named.set(anchor.record, { ref: anchor.record, title: null });
  return named;
}

export function modelPathLabel(path, model = {}) {
  const fields = Array.isArray(model.fields) ? model.fields : [];
  return path.map((part, index) => typeof part === 'number' ? String(part + 1)
    : index === 0 ? fields.find(field => field.id === part)?.label ?? readable(part) : readable(part)).join(' · ');
}

/** Each ordered object is its own group. A checklist, experiment series, chapter,
 *  transformation list and any future object array use exactly the same projection. */
export function modelFactGroups(model = {}) {
  const groups = new Map();
  for (const fact of Array.isArray(model.facts) ? model.facts : []) {
    if (!Array.isArray(fact?.path) || !fact.path.length) continue;
    const lastOrdinal = fact.path.findLastIndex(part => typeof part === 'number');
    const path = lastOrdinal < 0 ? [] : fact.path.slice(0, lastOrdinal + 1);
    const key = pathKey(path);
    if (!groups.has(key)) groups.set(key, { id: key, path, label: path.length ? modelPathLabel(path, model) : 'Fields', facts: [] });
    groups.get(key).facts.push({ ...fact, id: pathKey(fact.path),
      label: modelPathLabel(path.length ? fact.path.slice(path.length) : fact.path, model) });
  }
  return [...groups.values()];
}

/** An in-memory navigation projection of the facts already returned by their
 * owner. Container paths retain typed keys and array ordinals; no record is
 * created and no missing container is inferred from an absent fact. Arrays
 * kept as one fact (including mixed arrays) use the same bounded collection UI
 * as decomposed arrays of objects. */
export function modelValueTree(model = {}) {
  const nodes = new Map();
  const root = { id: '[]', path: [], label: 'Record', kind: 'object', children: [], values: [] };
  nodes.set(root.id, root);
  const ensure = path => {
    let parent = root;
    for (let index = 0; index < path.length; index++) {
      const prefix = path.slice(0, index + 1), id = pathKey(prefix);
      if (!nodes.has(id)) {
        const node = { id, path: prefix, label: modelPathLabel(prefix, model), kind: null, children: [], values: [] };
        nodes.set(id, node); parent.children.push(node);
      }
      if (parent.kind === null) parent.kind = typeof path[index] === 'number' ? 'array' : 'object';
      parent = nodes.get(id);
    }
    return parent;
  };
  const keep = (path, value) => {
    const node = ensure(path);
    node.kind = Array.isArray(value) ? 'array' : object(value) ? 'object' : 'value';
    if (Array.isArray(value)) {
      if (!value.length) node.values.push(value);
      value.forEach((item, ordinal) => keep([...path, ordinal], item));
    } else if (object(value)) {
      if (!Object.keys(value).length) node.values.push(value);
      for (const [key, item] of Object.entries(value)) keep([...path, key], item);
    } else node.values.push(value);
  };
  for (const fact of Array.isArray(model.facts) ? model.facts : []) {
    if (!Array.isArray(fact?.path) || fact.path.some(key => typeof key !== 'string'
      && !(Number.isSafeInteger(key) && key >= 0))) continue;
    keep(fact.path, fact.value);
  }
  // Facts may arrive in a different field order; array identity still means its
  // actual ordinal, never the incidental order a store returned the facts in.
  for (const node of nodes.values()) if (node.kind === 'array') node.children.sort((a, b) => a.path.at(-1) - b.path.at(-1));
  return { root, nodes };
}

/** Object-keyed sibling records are collections too. Their keys remain strings,
 * including numeric-looking keys; only actual array members have ordinals. */
export const modelValueIsCollection = node => node?.kind === 'array'
  || node?.kind === 'object' && node.children.length > 1 && node.children.every(child => child.kind !== 'value');

/** Scalar fields through plain objects, stopping at collections. This keeps a
 * nested criterion, measurement or description readable without assigning a
 * semantic role to any property name. Every supplied false/null/empty value is
 * retained, including duplicate occurrences at separate exact paths. */
export function modelValueFields(tree, path = [], model = {}) {
  const selected = tree.nodes.get(pathKey(path));
  if (!selected) return [];
  const fields = [];
  const visit = node => {
    for (const [occurrence, value] of node.values.entries()) fields.push({
      id: pathKey([node.path, occurrence]), path: node.path,
      relative: node.path.slice(path.length), label: node.path.length === path.length ? 'Value' : modelPathLabel(node.path.slice(path.length), path.length ? {} : model), value,
    });
    if (!modelValueIsCollection(node)) for (const child of node.children) visit(child);
  };
  visit(selected);
  return fields;
}

/** The next collection boundaries, without descending into their members. */
export function modelValueCollections(tree, path = []) {
  const selected = tree.nodes.get(pathKey(path)), collections = [];
  if (modelValueIsCollection(selected)) return collections;
  const visit = node => {
    if (modelValueIsCollection(node)) collections.push(node);
    else for (const child of node.children) visit(child);
  };
  if (selected) for (const child of selected.children) visit(child);
  return collections;
}

/** Transparent singleton wrappers can open directly, with their exact paths
 * still in the breadcrumb. No plural collection or scalar field is skipped. */
export function modelInitialPath(tree) {
  let node = tree.root;
  while (node.values.length === 0 && node.children.length === 1
    && (node.kind === 'object' || node.kind === 'array')
    && node.children[0].kind !== 'value') node = node.children[0];
  return node.path;
}

export function modelValueSelection(tree, part) {
  const initial = modelInitialPath(tree);
  if (!part) return { state: 'whole', path: initial };
  if (part.kind !== 'field' || !Array.isArray(part.path)
    || part.path.some(key => typeof key !== 'string' && !(Number.isSafeInteger(key) && key >= 0)))
    return { state: 'unsupported', path: initial };
  return tree.nodes.has(pathKey(part.path)) ? { state: 'addressed', path: part.path }
    : { state: 'unavailable', path: initial };
}

/** References travel with their containing value. An anchor object is not a
 * new enclosing record; the preceding array member is its containing value.
 * This prevents a parent collection drawing all descendants' evidence at once. */
export function modelScopedAnchors(anchors, path = [], tree = null) {
  const anchorPaths = new Set(anchors.map(anchor => pathKey(anchor.path)));
  return anchors.filter(anchor => {
    if (!samePath(anchor.path.slice(0, path.length), path)) return false;
    let owner = [];
    for (let index = 0; index < anchor.path.length; index++) {
      if (tree ? !modelValueIsCollection(tree.nodes.get(pathKey(anchor.path.slice(0, index)))) : typeof anchor.path[index] !== 'number') continue;
      const candidate = anchor.path.slice(0, index + 1);
      if (!anchorPaths.has(pathKey(candidate))) owner = candidate;
    }
    return owner.length <= path.length;
  });
}

/** Known owner metadata is a display/navigation projection, never a new identity. */
export function modelReference(model, ref) {
  return modelLabels(model).get(ref) ?? { ref, title: null };
}

export function modelRelations(model = {}) {
  const rows = [];
  const labels = modelLabels(model);
  for (const [direction, entries] of [['outgoing', model.parts], ['incoming', model.holders]]) {
    for (const [index, part] of (Array.isArray(entries) ? entries : []).entries()) {
      if (!text(part?.id) || !text(part?.role)) continue;
      const named = labels.get(part.id) ?? { ref: part.id, title: null };
      rows.push({ id: pathKey([direction, part.id, part.role, part.ordinal ?? null, index]), ref: part.id,
        title: text(named.title ?? named.label) ?? part.id, role: part.role,
        role_label: modelPathLabel([part.role], model), direction,
        position: Number.isSafeInteger(part.ordinal) && part.ordinal >= 0 ? part.ordinal + 1 : null,
        set: text(part.set), basis: 'Saved relationship; open the source to inspect its evidence', named });
    }
  }
  return rows;
}

/** Find the existing response anchor shape in facts without interpreting a format
 *  name, a checkbox or a caption as proof. Unknown part kinds stay fully inspectable. */
export function modelAnchors(model = {}) {
  const facts = [];
  // Some owners retain a mixed array as one attribute fact. Expose only its
  // actual nested values to the existing anchor detector; ordinary strings do
  // not become references and primitive locator arrays keep their exact value.
  const expand = fact => {
    if (object(fact.value) && Object.keys(fact.value).length) for (const [key, value] of Object.entries(fact.value)) expand({ path: [...fact.path, key], value });
    else if (Array.isArray(fact.value) && fact.value.some(value => value !== null && typeof value === 'object'))
      fact.value.forEach((value, ordinal) => expand({ path: [...fact.path, ordinal], value }));
    else facts.push(fact);
  };
  for (const fact of Array.isArray(model.facts) ? model.facts : []) if (Array.isArray(fact?.path)) expand(fact);
  const anchors = [];
  const seen = new Set();
  const add = (path, record) => {
    if (!text(record) || seen.has(pathKey(path))) return;
    const part = partAt(facts, path);
    if (part === null) return;
    seen.add(pathKey(path));
    anchors.push({ id: pathKey(path), path, label: modelPathLabel(path, model) || (part ? 'Addressed part' : 'Addressed record'),
      record, ...(part ? { part } : {}) });
  };
  for (const fact of facts) {
    if (fact.path.at(-1) !== 'record' || !text(fact.value)) continue;
    add(fact.path.slice(0, -1), fact.value);
  }
  // Existing kinds may keep anchors as typed references (for example a message's
  // about array). Their own link declaration supplies the paths and naming rule.
  for (const link of scopeData.links.filter(link => link.from === model.type && link.each)) {
    for (const fact of facts) {
      if (!samePath(fact.path.slice(0, link.field.length), link.field)) continue;
      const path = fact.path.slice(0, link.field.length + 1);
      if (!samePath(fact.path, [...path, ...link.each.id])) continue;
      const kind = facts.find(one => samePath(one.path, [...path, ...link.each.kind]))?.value;
      if (text(kind) && text(fact.value)) add(path, refOf(kind, fact.value));
    }
  }
  return anchors;
}

/** The file owner already opens a moment in seconds. Other part kinds retain their
 *  anchor and open inspection; they are never guessed to mean a time range. */
export function modelAnchorTarget(anchor) {
  const record = text(anchor?.record);
  if (!record) return null;
  const part = modelPart(anchor.part);
  const file = record.replace(/^file:/, '');
  const start = own(part, 'start_ms');
  const end = own(part, 'end_ms');
  if (/^(1f|12):[a-f0-9]{64}$/i.test(file) && part?.kind === momentWords.part_kind
    && typeof start === 'number' && Number.isFinite(start) && start >= 0) {
    const at = start / 1000;
    return { screen: 'trillion.file', input: { id: file, at }, href: `/file/${encodeURIComponent(file)}?at=${at}`,
      title: `Open at ${at.toLocaleString()}s`, range: typeof end === 'number' && Number.isFinite(end) && end >= start ? [at, end / 1000] : [at, null] };
  }
  return { screen: 'trillion.activity-trace', input: { item: record, ...(part ? { part } : {}) },
    href: `/activity/trace/${encodeURIComponent(record)}${part ? `?${new URLSearchParams({ part: JSON.stringify(part) })}` : ''}`, title: 'Inspect addressed record', range: null };
}
