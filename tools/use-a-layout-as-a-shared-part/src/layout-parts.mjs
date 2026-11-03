// src/layout-parts.mjs
//
// Purpose
//   A layout used inside another as a shared part (src/layouts.mjs). An arrangement node
//   { kind: 'part', layout: <layout_id>, version?: <its version number>, overrides?: { <key>: { <field>: value, hidden?: true } } }
//   stands for that layout's arrangement: at the version it is pinned to, or the layout as it is now when unpinned.
//   Any node may carry `key`, the inner id an override names. Expanding a written arrangement gives the plain
//   arrangement the page draws (parts/screen-arrangement/read-data/starter-layouts.ts) plus the parts it used.
//
// Non-negotiable invariants
//   1. Pure: the layouts owner resolves a part ({ layout, version } → { arrangement, fell_back? } | null); this file
//      reads no records.
//   2. An override only sets the fields src/layouts.json parts.overridable names, or hides the node (`hidden: true`); it
//      names a key the part has, else it is refused with the keys the part has. Hiding a split's child drops that
//      child's size; a part cannot hide itself whole.
//   3. A part never holds itself, directly or through another part, and sits at most parts.depth deep.
//   4. A pin to a version no longer kept follows the layout as it is now, and says so (`fell_back`).
//

import settings from './layouts.json' with { type: 'json' };

const { overridable: OVERRIDABLE, depth: DEPTH } = settings.parts;
const isNode = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');

/** Whether a written arrangement names a part or an inner key (and so is kept as written beside its expansion). */
export function writtenWithParts(node) {
  if (!isNode(node)) return false;
  if (node.kind === 'part' || typeof node.key === 'string') return true;
  return Array.isArray(node.children) && node.children.some(writtenWithParts);
}

/** The parts a written arrangement uses at its own level ({ layout, version: pinned edit | null }), in order. */
export function partsUsedBy(node) {
  if (!isNode(node)) return [];
  if (node.kind === 'part') return [{ layout: text(node.layout), version: Number.isSafeInteger(node.version) ? node.version : null }];
  return Array.isArray(node.children) ? node.children.flatMap(partsUsedBy) : [];
}

/** The written arrangement with every use of `part` pinned to `version` (null: unpinned). */
export function pinPart(node, part, version) {
  if (!isNode(node)) return node;
  if (node.kind === 'part') {
    if (text(node.layout) !== part) return node;
    const rest = { ...node };
    delete rest.version;
    return version === null ? rest : { ...rest, version };
  }
  return Array.isArray(node.children) ? { ...node, children: node.children.map(child => pinPart(child, part, version)) } : node;
}

const keysIn = node => (isNode(node) ? [...(typeof node.key === 'string' ? [node.key] : []), ...(Array.isArray(node.children) ? node.children.flatMap(keysIn) : [])] : []);

function override(node, overrides, part) {
  const asked = Object.keys(overrides);
  if (!asked.length) return node;
  const known = new Set(keysIn(node));
  const unknown = asked.filter(key => !known.has(key));
  if (unknown.length) throw new Error(`The layout ${part} has no part keyed ${unknown.join(', ')}; its keys are ${[...known].join(', ') || 'none'}.`);
  for (const [key, change] of Object.entries(overrides)) {
    if (!isNode(change)) throw new Error(`The override for ${key} is { <field>: value, hidden?: true }.`);
    const refused = Object.keys(change).filter(field => field !== 'hidden' && !OVERRIDABLE.includes(field));
    if (refused.length) throw new Error(`An override may set ${OVERRIDABLE.join(', ')} or hidden, not ${refused.join(', ')}.`);
  }
  if (overrides[node.key]?.hidden === true) throw new Error(`The layout ${part} cannot hide its whole arrangement; remove the part instead.`);
  const walk = current => {
    const fields = { ...(overrides[current.key] ?? {}) };
    delete fields.hidden;
    const next = { ...current, ...fields };
    if (!Array.isArray(next.children)) return next;
    const kept = next.children.map((child, at) => [child, at]).filter(([child]) => overrides[child.key]?.hidden !== true);
    const keepAt = values => (Array.isArray(values) && values.length === next.children.length ? kept.map(([, at]) => values[at]) : values);
    return { ...next, sizes: keepAt(next.sizes), across: keepAt(next.across), children: kept.map(([child]) => walk(child)) };
  };
  return walk(node);
}

/**
 * Expands a written arrangement: every part becomes its layout's arrangement (pinned or now), with its overrides.
 * resolve({ layout, version }) → { arrangement, fell_back? } | null (may be async). `trail` is the layouts this
 * arrangement already sits inside (a layout's own id first). Answers { arrangement, used: [{ layout, pinned,
 * fell_back? }] } where `used` are the parts at this arrangement's own level.
 */
export async function expandParts(node, resolve, trail = []) {
  const used = [];
  const expand = async (current, path, record) => {
    if (!isNode(current)) return current;
    if (current.kind === 'part') {
      const layout = text(current.layout);
      if (!layout) throw new Error('A part names the layout it uses: { kind: "part", layout: <layout_id> }.');
      if (path.includes(layout)) throw new Error(`The layout ${layout} would sit inside itself (${[...path, layout].join(' → ')}).`);
      if (path.length - trail.length >= DEPTH) throw new Error(`Parts sit at most ${DEPTH} deep inside one another.`);
      const pinned = Number.isSafeInteger(current.version) ? current.version : null;
      const found = await resolve({ layout, version: pinned });
      if (!found) throw new Error(`There is no layout ${layout} to use as a part; read_layouts lists every layout_id.`);
      if (record) used.push({ layout, pinned, ...(found.fell_back ? { fell_back: true } : {}) });
      const inner = await expand(structuredClone(found.arrangement), [...path, layout], false);
      return override(inner, isNode(current.overrides) ? current.overrides : {}, layout);
    }
    if (!Array.isArray(current.children)) return current;
    const children = [];
    for (const child of current.children) children.push(await expand(child, path, record));
    return { ...current, children };
  };
  return { arrangement: await expand(node, trail, true), used };
}

/** The written arrangement with every use of `part` replaced by what it expands to now, so it no longer uses it. */
export async function inlinePart(node, part, resolve) {
  if (!isNode(node)) return node;
  if (node.kind === 'part') return text(node.layout) === part ? (await expandParts(node, resolve)).arrangement : node;
  if (!Array.isArray(node.children)) return node;
  const children = [];
  for (const child of node.children) children.push(await inlinePart(child, part, resolve));
  return { ...node, children };
}
