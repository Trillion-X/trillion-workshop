// parts/ui/show/layer-diagram/graph-contract.mjs
//
// A TYPED GRAPH DOCUMENT, CHECKED, THEN DRAWN THE SAME EVERY TIME.
//
// Purpose: the contract a graph arrives in before ./layer-diagram.mjs draws it. An AI or a person writes a small
// document (lanes of nodes, edges between them, each node and edge saying whether it was added, modified, removed
// or left unchanged); `validateGraphDocument` checks it in two passes and answers every refusal with a machine code and
// the path it is at; `renderGraphDocument` draws a valid one through the one layout and returns the markup, the
// geometry sidecar (id -> box, ./layer-diagram.mjs layerDiagramAtlas) and the BLAKE3 identity of each, so two runs of the
// same document are provably the same bytes. The model never draws; it writes the document, the layout draws it.
//
// Non-negotiable invariants:
//   1. Every vocabulary is DATA (./graph-contract.json): node kinds, edge kinds, change states, the look each wears,
//      the limits and the words of each refusal. This file names no kind, no state and no limit.
//   2. A document says what and how connected, never where. A position or size is refused (POSITION_NOT_ALLOWED);
//      the only layout hint is `min_height`, a floor the layout may exceed and never go below, so a document cannot
//      break the picture.
//   3. If it validates, it draws. Limits come from one table; a reference to a node nobody declared (BROKEN_REFERENCE),
//      a repeated id (DUPLICATE_ID) and an edge from a node to itself (SELF_EDGE) are refused, never silently dropped.
//      An unknown kind is not a failure when the DATA says so: it draws plain and says UNKNOWN_KIND as a warning.
//   4. Pure for ordinary JSON documents under a valid contract: no clock, random number, file, network or script in
//      the output. Malformed document shapes return findings instead of throwing. The same document and contract
//      always give the same markup, atlas and identities.
//   5. Content identities use the declared 1f BLAKE3 identity of the exact bytes (UTF-8 markup; atlas as JSON).
//
// Key concepts: `graphIdentity(document)`, `validateGraphDocument(document, contract?)` -> { ok, errors, warnings, diagram },
// `renderGraphDocument(document, contract?)` -> { ok, errors, warnings, html, atlas, identity }, `graphDocumentHtml`.

import { blake3 } from '../../../live-namespace/do-work/blake3.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';
import contract from './graph-contract.json' with { type: 'json' };
import { escapeHtml } from '../server-rendered-page/escape-html.mjs';
import { sanitizeErrorText } from '../safe-error-card/sanitize-error-text.ts';
import { layerDiagramAtlas, layerDiagramHtml, layerDiagramLayout } from './layer-diagram.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const identityOf = (text) => `1f:${bytesToHex(blake3(new TextEncoder().encode(text)))}`;

/** One refusal or warning: its machine code, the path it is at, and its words from the contract's DATA. */
function finding(rules, code, path, values = {}) {
  return { code, path, message: fill(rules.words.errors[code], { path, ...values }) };
}

/** A text field: absent is fine when `required` is false; present must be a non-empty string within `most` characters. */
function textField(owner, key, path, { required, most }, rules, errors) {
  const value = owner[key];
  if (value === undefined || value === null) {
    if (required) errors.push(finding(rules, 'MISSING_FIELD', path));
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) { errors.push(finding(rules, 'WRONG_TYPE', path, { expected: 'a non-empty string' })); return null; }
  if ([...value.trim()].length > most) { errors.push(finding(rules, 'TOO_LONG', path, { most })); return null; }
  return value.trim();
}

function idField(owner, path, rules, errors) {
  const value = owner.id;
  if (value === undefined || value === null) { errors.push(finding(rules, 'MISSING_FIELD', `${path}.id`)); return null; }
  if (typeof value !== 'string' || !new RegExp(rules.id_pattern, 'u').test(value)) { errors.push(finding(rules, 'BAD_ID', `${path}.id`)); return null; }
  return value;
}

function deltaTone(owner, path, side, rules, errors) {
  const states = Object.keys(rules.delta.states);
  const value = owner.delta;
  if (value === undefined || value === null) {
    if (rules.delta.required) errors.push(finding(rules, 'MISSING_DELTA', `${path}.delta`, { states: states.join(', ') }));
    return null;
  }
  if (typeof value !== 'string' || !Object.hasOwn(rules.delta.states, value)) {
    errors.push(finding(rules, 'INVALID_DELTA', `${path}.delta`, { found: String(value), states: states.join(', ') }));
    return null;
  }
  return rules.delta.states[value][side] ?? null;
}

/** The kind a node or edge names: its kind's DATA row, or null (plain) with UNKNOWN_KIND said or refused per the DATA. */
function kindRow(owner, path, side, rules, errors, warnings) {
  const kind = owner.kind;
  if (kind === undefined || kind === null) return null;
  const known = rules.kinds[side];
  if (typeof kind === 'string' && Object.hasOwn(known, kind)) return known[kind];
  if (typeof kind !== 'string') { errors.push(finding(rules, 'WRONG_TYPE', `${path}.kind`, { expected: 'a string' })); return null; }
  if (rules.kinds.unknown === 'draw_plain') warnings.push(finding(rules, 'UNKNOWN_KIND', `${path}.kind`, { found: kind }));
  else errors.push(finding(rules, 'REFUSED_KIND', `${path}.kind`, { found: kind, kinds: Object.keys(known).join(', ') }));
  return null;
}

function refusePositions(owner, path, rules, errors) {
  for (const key of rules.forbidden_fields) if (Object.hasOwn(owner, key)) errors.push(finding(rules, 'POSITION_NOT_ALLOWED', `${path}.${key}`));
}

function refuseUnknownFields(owner, path, shape, rules, errors) {
  const allowed = rules.allowed_fields[shape];
  for (const key of Object.keys(owner)) {
    if (!allowed.includes(key) && !rules.forbidden_fields.includes(key)) {
      errors.push(finding(rules, 'UNKNOWN_FIELD', `${path}.${key}`, { found: key }));
    }
  }
}

function nodeOf(raw, path, rules, errors, warnings) {
  if (!isObject(raw)) { errors.push(finding(rules, 'NOT_AN_OBJECT', path)); return { id: null, node: null }; }
  refusePositions(raw, path, rules, errors);
  refuseUnknownFields(raw, path, 'node', rules, errors);
  if (raw.mark !== undefined && raw.mark !== null && !isObject(raw.mark)) {
    errors.push(finding(rules, 'WRONG_TYPE', `${path}.mark`, { expected: 'an object' }));
  } else if (isObject(raw.mark)) {
    refuseUnknownFields(raw.mark, `${path}.mark`, 'mark', rules, errors);
    for (const key of ['image', 'letters']) {
      if (raw.mark[key] !== undefined && raw.mark[key] !== null && typeof raw.mark[key] !== 'string') {
        errors.push(finding(rules, 'WRONG_TYPE', `${path}.mark.${key}`, { expected: 'a string' }));
      }
    }
  }
  const id = idField(raw, path, rules, errors);
  const label = textField(raw, 'label', `${path}.label`, { required: true, most: rules.limits.label_characters }, rules, errors);
  const originalDetail = textField(raw, 'detail', `${path}.detail`, { required: false, most: rules.limits.detail_characters }, rules, errors);
  const tone = deltaTone(raw, path, 'node', rules, errors);
  const detail = [rules.delta.states[raw.delta]?.label, originalDetail].filter(Boolean).join(' · ');
  const kind = kindRow(raw, path, 'node', rules, errors, warnings);
  let floor = null;
  if (raw.min_height !== undefined) {
    if (Number.isSafeInteger(raw.min_height) && raw.min_height >= 0 && raw.min_height <= rules.limits.floor_height_most) floor = raw.min_height;
    else errors.push(finding(rules, 'BAD_FLOOR', `${path}.min_height`, { most: rules.limits.floor_height_most }));
  }
  const mark = isObject(raw.mark) ? raw.mark : kind?.letters ? { letters: kind.letters } : null;
  if (id === null) return { id, node: null };
  if (label === null) return { id, node: null };
  return { id, node: { id, label, delta: raw.delta, ...(detail ? { detail } : {}), ...(mark ? { mark } : {}), ...(tone ? { tone } : {}), ...(floor ? { min_height: floor } : {}) } };
}

/**
 * Pass 1 (structure) and pass 2 (references) over an ordinary JSON `document` under a valid contract.
 * -> { ok, errors: [{ code, path, message }], warnings: [{ code, path, message }], diagram | null }
 * `diagram` is the layer diagram (./layer-diagram.mjs) the document means, present only when `ok`.
 */
export function validateGraphDocument(document, rules = contract) {
  const errors = [];
  const warnings = [];
  if (!isObject(document)) return { ok: false, errors: [finding(rules, 'NOT_AN_OBJECT', 'document')], warnings, diagram: null };
  refusePositions(document, 'document', rules, errors);
  refuseUnknownFields(document, 'document', 'document', rules, errors);

  const version = document.schema_version;
  if (version === undefined || version === null) errors.push(finding(rules, 'MISSING_FIELD', 'document.schema_version'));
  else if (!Number.isSafeInteger(version) || version < rules.oldest_schema_version || version > rules.schema_version) {
    errors.push(finding(rules, 'UNSUPPORTED_VERSION', 'document.schema_version', { found: String(version), oldest: rules.oldest_schema_version, newest: rules.schema_version }));
  }
  const id = idField(document, 'document', rules, errors);
  const label = textField(document, 'label', 'document.label', { required: true, most: rules.limits.label_characters }, rules, errors);
  const caption = textField(document, 'caption', 'document.caption', { required: false, most: rules.limits.caption_characters }, rules, errors);

  const laneList = Array.isArray(document.lanes) ? document.lanes : null;
  if (!laneList) errors.push(finding(rules, document.lanes === undefined ? 'MISSING_FIELD' : 'WRONG_TYPE', 'document.lanes', { expected: 'a list' }));
  else if (laneList.length > rules.limits.lanes) errors.push(finding(rules, 'TOO_MANY', 'document.lanes', { most: rules.limits.lanes }));
  const edgeList = document.edges === undefined ? [] : document.edges;
  if (!Array.isArray(edgeList)) errors.push(finding(rules, 'WRONG_TYPE', 'document.edges', { expected: 'a list' }));
  else if (edgeList.length > rules.limits.edges) errors.push(finding(rules, 'TOO_MANY', 'document.edges', { most: rules.limits.edges }));

  // Pass 1: structure. Ids share one namespace (lanes and nodes), first use wins, a repeat is DUPLICATE_ID.
  const seen = new Map();
  const claim = (identity, path) => {
    if (seen.has(identity)) { errors.push(finding(rules, 'DUPLICATE_ID', path, { found: identity, first: seen.get(identity) })); return false; }
    seen.set(identity, path);
    return true;
  };
  let nodeCount = 0;
  let nodeLimitExceeded = false;
  const declared = new Set();
  const layers = [];
  (laneList ?? []).slice(0, rules.limits.lanes).forEach((lane, laneIndex) => {
    const lanePath = `document.lanes[${laneIndex}]`;
    if (!isObject(lane)) { errors.push(finding(rules, 'NOT_AN_OBJECT', lanePath)); return; }
    refusePositions(lane, lanePath, rules, errors);
    refuseUnknownFields(lane, lanePath, 'lane', rules, errors);
    const laneId = idField(lane, lanePath, rules, errors);
    const laneLabel = textField(lane, 'label', `${lanePath}.label`, { required: false, most: rules.limits.label_characters }, rules, errors);
    if (laneId !== null) claim(laneId, `${lanePath}.id`);
    const nodes = [];
    if (!Array.isArray(lane.nodes)) errors.push(finding(rules, lane.nodes === undefined ? 'MISSING_FIELD' : 'WRONG_TYPE', `${lanePath}.nodes`, { expected: 'a list' }));
    else {
      const visitCount = Math.min(lane.nodes.length, Math.max(0, rules.limits.nodes - nodeCount));
      if (visitCount < lane.nodes.length) nodeLimitExceeded = true;
      for (let nodeIndex = 0; nodeIndex < visitCount; nodeIndex += 1) {
        const raw = lane.nodes[nodeIndex];
        nodeCount += 1;
        const nodePath = `${lanePath}.nodes[${nodeIndex}]`;
        // A node with a fault of its own still declares its id, so an edge to it is not also reported as broken.
        const { id: nodeId, node } = nodeOf(raw, nodePath, rules, errors, warnings);
        if (nodeId !== null && claim(nodeId, `${nodePath}.id`)) {
          declared.add(nodeId);
          if (node) nodes.push(node);
        }
      }
    }
    layers.push({ id: laneId ?? `lane-${laneIndex}`, ...(laneLabel ? { label: laneLabel } : {}), nodes });
  });
  if (nodeLimitExceeded) errors.push(finding(rules, 'TOO_MANY', 'document.lanes.nodes', { most: rules.limits.nodes }));
  if (nodeCount === 0) errors.push(finding(rules, 'EMPTY_GRAPH', 'document.lanes'));

  // Pass 2: references. An edge may only join nodes some lane declared.
  const edges = [];
  (Array.isArray(edgeList) ? edgeList.slice(0, rules.limits.edges) : []).forEach((raw, edgeIndex) => {
    const path = `document.edges[${edgeIndex}]`;
    if (!isObject(raw)) { errors.push(finding(rules, 'NOT_AN_OBJECT', path)); return; }
    refusePositions(raw, path, rules, errors);
    refuseUnknownFields(raw, path, 'edge', rules, errors);
    const tone = deltaTone(raw, path, 'edge', rules, errors);
    const kind = kindRow(raw, path, 'edge', rules, errors, warnings);
    const written = textField(raw, 'label', `${path}.label`, { required: false, most: rules.limits.label_characters }, rules, errors);
    const ends = ['from', 'to'].map((end) => {
      const value = raw[end];
      if (value === undefined || value === null) { errors.push(finding(rules, 'MISSING_FIELD', `${path}.${end}`)); return null; }
      if (typeof value !== 'string') { errors.push(finding(rules, 'WRONG_TYPE', `${path}.${end}`, { expected: 'a node id' })); return null; }
      if (!declared.has(value)) { errors.push(finding(rules, 'BROKEN_REFERENCE', `${path}.${end}`, { found: value })); return null; }
      return value;
    });
    if (ends[0] !== null && ends[0] === ends[1]) errors.push(finding(rules, 'SELF_EDGE', path, { found: ends[0] }));
    const edgeLabel = [rules.delta.states[raw.delta]?.label, written ?? kind?.label].filter(Boolean).join(' · ');
    if (ends[0] !== null && ends[1] !== null) edges.push({ from: ends[0], to: ends[1], delta: raw.delta, ...(tone ? { tone } : {}), ...(edgeLabel ? { label: edgeLabel } : {}) });
  });

  if (errors.length) return { ok: false, errors, warnings, diagram: null };
  return { ok: true, errors, warnings, diagram: { id, label, ...(caption ? { caption } : {}), layers, edges } };
}

/**
 * `document` validated and drawn through the one layout. -> { ok, errors, warnings, html, atlas, identity }
 * `html` is the figure `layerDiagramHtml` draws; `atlas` is { across, down }, each a `layerDiagramAtlas`;
 * `identity` is { html, atlas } as BLAKE3 hex. A refused document answers its errors and nothing drawn.
 */
export function renderGraphDocument(document, rules = contract) {
  const checked = validateGraphDocument(document, rules);
  if (!checked.ok) return { ok: false, errors: checked.errors, warnings: checked.warnings, html: '', atlas: null, identity: null };
  const html = layerDiagramHtml(checked.diagram);
  const atlas = { across: layerDiagramAtlas(layerDiagramLayout(checked.diagram, 'across')), down: layerDiagramAtlas(layerDiagramLayout(checked.diagram, 'down')) };
  return { ok: true, errors: [], warnings: checked.warnings, html, atlas, identity: { html: identityOf(html), atlas: identityOf(JSON.stringify(atlas)) } };
}

/** A page block's graph document as markup: the picture when it is valid, else each refusal's code with its words through
 * the failure-words gate (never an empty gap). */
export function graphDocumentHtml(document, rules = contract) {
  if (document === undefined || document === null) return '';
  const drawn = renderGraphDocument(document, rules);
  if (drawn.ok) return drawn.html;
  return `<div class="layer-diagram-refused" role="alert"><p>${escapeHtml(rules.words.invalid_heading)}</p><ul>`
    + drawn.errors.map((refusal) => `<li><code>${escapeHtml(refusal.code)}</code> ${escapeHtml(sanitizeErrorText(refusal.message, rules.words.refusal_fallback))}</li>`).join('') + '</ul></div>';
}

/** The declared 1f BLAKE3 identity of `text` as UTF-8 bytes. */
export { identityOf };

const canonicalJson = (value) => JSON.stringify(value, (_key, inner) => (isObject(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner));
/** The identity of a graph document as data: its keys in sorted order, so key order never changes it. */
export const graphIdentity = (document) => identityOf(canonicalJson(document));
