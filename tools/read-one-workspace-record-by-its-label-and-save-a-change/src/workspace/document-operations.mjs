// src/workspace/document-operations.mjs
//
// PURPOSE
//   A document edited as a sequence of operations, the one engine the page (src/workspace/document-operation-sync.mjs)
//   and the person's store (src/native-workspace-records.mjs applyDocumentOperations) both run. A document is ordered
//   blocks; each block keeps its props as last-writer registers and its words either as one whole text (format 0, how
//   documents were kept before) or as an id-addressed character sequence (format 1). Operations name blocks and
//   characters by id, never by position, so an operation made against an older copy still means the same thing after
//   other people's and AIs' operations: words are a sequence CRDT (each insertion anchored after a character id,
//   siblings ordered by Lamport stamp), a block's place is a last-writer position key (ordered by key, then id), and
//   props are last-writer registers, so applying any two plain operations in either order gives the same document.
//   The store orders every batch once; guarded operations (the inverses an undo issues) are decided in that order.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every function is pure: it returns a new document and never changes its input.
//   2. Identity is store-owned. Every inserted block's id is minted from its operation's stamp (letter-first and the same
//      on every copy); the id an editor proposed is kept on the operation as `block`, the batch's later operations that
//      name it are pointed at the minted id, and `applied` answers the minted one so the editor can follow it. Opening a
//      document repairs malformed or repeated stored ids deterministically. Character ids are made from the inserting
//      stamp, so they are unique without coordination.
//   3. A document whose schema_version is newer than this build's (document-operations.json) is refused with
//      code 'schema_newer'; it is never opened, changed or written back.
//   4. Each block names its own format_version, so whole-text blocks and sequence blocks coexist; a whole-text block
//      becomes a sequence on its first text operation, with character ids every copy derives identically.
//   5. Undo inverts only the actor's own operations, by id: deleting what they inserted never removes words another
//      person or AI inserted among them, restoring what they deleted removes only their own deletion mark, and a prop or
//      position someone changed later is left as that person set it (the inverse carries a guard).
//   6. Every bound (batch, document, insert, undo depth) is DATA in document-operations.json.
//
//   openDocument(raw) -> document | throws DocumentOperationError
//   documentFromBlocks([{ id, text, props }]) -> document of whole-text blocks, ids repaired
//   keyBetween(before, after) -> a position key strictly between two keys (null: no bound)
//   documentView(document) -> [{ id, text, props, format_version }]
//   applyOperations(document, ops, { actor }) -> { document, applied, inverse }
//   stampOperations(document, ops, actor) -> ops with consecutive stamps after the document's clock
//   editsToward(document, blocks, actor) -> stamped ops turning the document's view into `blocks`
//   undoStack: pushUndo(stack, inverse), takeUndo(stack, document, actor)
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import rules from './document-operations.json' with { type: 'json' };

export const DOCUMENT_SCHEMA_VERSION = rules.schema_version;
export const DOCUMENT_LIMITS = Object.freeze({ ...rules.limits });
export const DOCUMENT_OPERATIONS_LABEL_PREFIX = rules.label_prefix;
const WHOLE = rules.format_versions.whole_text, SEQUENCE = rules.format_versions.character_sequence;
const L = DOCUMENT_LIMITS;

export class DocumentOperationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const refuse = (code, message, status) => { throw new DocumentOperationError(code, message, status); };

const BLOCK_ID = /^[A-Za-z][A-Za-z0-9:._~-]{0,119}$/;
const ACTOR = /^[A-Za-z0-9:._~@-]+$/;
const encoder = new TextEncoder();
const tagOf = text => bytesToHex(blake3(encoder.encode(text))).slice(0, 10);
const isStamp = stamp => Array.isArray(stamp) && stamp.length === 2 && Number.isSafeInteger(stamp[0]) && stamp[0] >= 0 && typeof stamp[1] === 'string';
/** Lamport order: counter, then actor, so every copy orders concurrent stamps the same way. */
export const compareStamps = (a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
const sameStamp = (a, b) => Boolean(a && b) && compareStamps(a, b) === 0;
const stampKey = stamp => `${stamp[0]}@${stamp[1]}`;
const runIdFor = stamp => `t${stamp[0].toString(36)}${tagOf(stamp[1])}`;
const mintedBlockId = stamp => `b${stamp[0].toString(36)}${tagOf(stamp[1])}`;
const charId = (run, k) => `${run}:${k}`;
const SEED = [0, ''];
const clone = value => structuredClone(value);
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Characters: children of an anchor by stamp, newest first, then id; walked without recursion so a long run of
// single-character insertions cannot exhaust the stack.
function childrenByAnchor(items, anchorOf, stampOf, idOf) {
  const children = new Map();
  for (const item of items) {
    const anchor = anchorOf(item) ?? '';
    if (!children.has(anchor)) children.set(anchor, []);
    children.get(anchor).push(item);
  }
  for (const list of children.values()) list.sort((a, b) => compareStamps(stampOf(b), stampOf(a)) || (idOf(a) < idOf(b) ? 1 : -1));
  return children;
}

// Block places: keys over the digits 0-9a-z, compared as text, never ending in '0', so there is always room between
// two keys. Moving or inserting a block writes one key and leaves every other block where it is.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const KEY = /^[0-9a-z]{0,199}[1-9a-z]$/;
export function keyBetween(before, after) {
  const lo = before ?? '';
  let hi = after, key = '';
  if (hi !== null && lo >= hi) refuse('key_invalid', 'A block place goes between two different places.');
  for (let i = 0; ; i += 1) {
    const l = i < lo.length ? DIGITS.indexOf(lo[i]) : 0;
    const h = hi !== null && i < hi.length ? DIGITS.indexOf(hi[i]) : DIGITS.length;
    // With no upper bound the next key is one step on, so appending blocks keeps keys short.
    if (hi === null && l + 1 < DIGITS.length) return key + DIGITS[l + 1];
    if (h - l > 1) return key + DIGITS[(l + h) >> 1];
    key += DIGITS[l];
    if (h - l === 1) hi = null;
  }
}
// Evenly spread keys for a document's first blocks.
const seedKeys = count => {
  const width = Math.max(1, Math.ceil(Math.log(count + 2) / Math.log(DIGITS.length)));
  return Array.from({ length: count }, (_, i) => (i + 1).toString(36).padStart(width, '0'));
};
const placeOrder = (document, a, b) => (document.blocks[a].key < document.blocks[b].key ? -1 : document.blocks[a].key > document.blocks[b].key ? 1 : a < b ? -1 : a > b ? 1 : 0);
const orderedBlockIds = document => Object.keys(document.blocks).sort((a, b) => placeOrder(document, a, b));

// The sequence form of a whole-text block: its words become one run every copy names alike ('s0').
function migrated(block) {
  if (block.format_version === SEQUENCE) return block;
  const { text, ...rest } = block;
  return { ...rest, format_version: SEQUENCE, deleted: {}, runs: text ? [{ id: 's0', after: null, s: SEED, text }] : [] };
}

/** The block's characters in order: [{ id, ch, deleted }]. A whole-text block answers its derived sequence ids. */
export function blockCharacters(block) {
  const sequence = migrated(block);
  const children = childrenByAnchor(sequence.runs, run => run.after, run => run.s, run => run.id);
  const out = [];
  const stack = [...(children.get('') ?? [])].reverse().map(run => ({ run, k: 0 }));
  while (stack.length) {
    const task = stack.pop();
    if (task.run) {
      const { run, k } = task;
      if (k >= run.text.length) continue;
      const id = charId(run.id, k);
      out.push({ id, ch: run.text[k], deleted: Boolean(sequence.deleted[id]?.length) });
      stack.push({ run, k: k + 1 });
      for (const child of [...(children.get(id) ?? [])].reverse()) stack.push({ run: child, k: 0 });
    }
  }
  return out;
}

const textOf = block => block.format_version === WHOLE ? block.text ?? '' : blockCharacters(block).filter(c => !c.deleted).map(c => c.ch).join('');
const propsOf = block => Object.fromEntries(Object.entries(block.props).filter(([, held]) => held.v !== null).map(([key, held]) => [key, clone(held.v)]));

/** What the document shows: blocks in order, removed ones left out. */
export function documentView(document) {
  return orderedBlockIds(document).filter(id => !document.blocks[id].removed?.v)
    .map(id => ({ id, text: textOf(document.blocks[id]), props: propsOf(document.blocks[id]), format_version: document.blocks[id].format_version }));
}

const itemCount = document => Object.values(document.blocks).reduce((sum, block) => sum + 1 + (block.format_version === WHOLE ? (block.text ?? '').length : block.runs.reduce((n, run) => n + run.text.length, 0)), 0);
const readProps = props => {
  if (props === undefined) return {};
  if (!plainObject(props) || Object.keys(props).length > L.props_per_block) refuse('props_invalid', `A block keeps at most ${L.props_per_block} props, as an object.`);
  return props;
};

// A stored id that is malformed or repeated gets a deterministic replacement from its place, so every copy repairs alike.
function repairedId(original, index, taken) {
  if (typeof original === 'string' && BLOCK_ID.test(original) && !taken.has(original)) return original;
  let attempt = 0, id;
  do { id = `r${tagOf(`${index}:${String(original)}:${attempt}`)}`; attempt += 1; } while (taken.has(id));
  return id;
}

/** A document of whole-text blocks (format 0), in the given order, from blocks kept before operations existed. */
export function documentFromBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > L.blocks_per_document) refuse('blocks_invalid', `A document holds at most ${L.blocks_per_document} blocks.`);
  const taken = new Set(), document = { schema_version: DOCUMENT_SCHEMA_VERSION, clock: 0, blocks: {} };
  const keys = seedKeys(blocks.length);
  blocks.forEach((block, index) => {
    const id = repairedId(block?.id, index, taken);
    taken.add(id);
    const props = readProps(block?.props);
    if (block?.text !== undefined && typeof block.text !== 'string') refuse('text_invalid', 'A block text is words.');
    document.blocks[id] = { key: keys[index], pos: SEED, made: SEED, removed: null, format_version: WHOLE, text: block?.text ?? '',
      props: Object.fromEntries(Object.entries(props).map(([key, v]) => [key, { v: clone(v), s: SEED }])) };
  });
  if (itemCount(document) > L.items_per_document) refuse('document_too_large', 'This document is larger than one edited document keeps.');
  return document;
}

/** A stored document checked and repaired: refused when its schema is newer than this build reads. */
export function openDocument(raw) {
  if (!plainObject(raw) || !plainObject(raw.blocks)) refuse('document_invalid', 'This is not a kept document.');
  if (!Number.isSafeInteger(raw.schema_version) || raw.schema_version < 1) refuse('document_invalid', 'This kept document names no schema version.');
  if (raw.schema_version > DOCUMENT_SCHEMA_VERSION) refuse('schema_newer', `This document was saved by a newer version of Trillion (schema ${raw.schema_version}; this one reads ${DOCUMENT_SCHEMA_VERSION}). Reload to open it.`, 409);
  const document = clone(raw);
  const taken = new Set(), renamed = new Map();
  Object.keys(document.blocks).forEach((id, index) => {
    const next = repairedId(id, index, taken);
    taken.add(next);
    if (next !== id) renamed.set(id, next);
  });
  if (renamed.size) document.blocks = Object.fromEntries(Object.entries(document.blocks).map(([id, block]) => [renamed.get(id) ?? id, block]));
  // A block with no readable place goes after every placed block, in id order, so every copy places it alike.
  let last = Object.values(document.blocks).map(block => block.key).filter(key => typeof key === 'string' && KEY.test(key)).sort().at(-1) ?? null;
  for (const id of Object.keys(document.blocks).sort()) if (typeof document.blocks[id].key !== 'string' || !KEY.test(document.blocks[id].key)) {
    last = keyBetween(last, null);
    document.blocks[id].key = last;
  }
  return document;
}

const blockOf = (document, id) => document.blocks[id] ?? refuse('block_missing', 'That block is not in this document.', 409);
function charExists(block, id) {
  const at = id.lastIndexOf(':');
  const run = at > 0 ? block.runs.find(one => one.id === id.slice(0, at)) : null;
  const k = Number(id.slice(at + 1));
  return Boolean(run) && Number.isSafeInteger(k) && k >= 0 && k < run.text.length;
}

// Each kind: how one stamped operation changes the document (in place on the working copy) and its inverse.
const KINDS = {
  insert_text(doc, op) {
    let block = blockOf(doc, op.block);
    if (typeof op.text !== 'string' || !op.text || op.text.length > L.chars_per_insert) refuse('text_invalid', `Insert between 1 and ${L.chars_per_insert} characters at a time.`);
    block = doc.blocks[op.block] = migrated(block);
    if (op.after !== null && (typeof op.after !== 'string' || !charExists(block, op.after))) refuse('anchor_missing', 'The words this insert follows are not in that block.', 409);
    const id = runIdFor(op.stamp);
    const prior = block.runs.find(run => run.id === id);
    if (prior) {
      if (prior.after === op.after && prior.text === op.text) return { applied: op, inverse: null };
      refuse('stamp_reused', 'This operation stamp was already used for other words.', 409);
    }
    // Runs are kept sorted by id, so every copy holds the same bytes whichever order it applied them in.
    block.runs.splice(block.runs.findIndex(run => run.id > id) >>> 0, 0, { id, after: op.after, s: op.stamp, text: op.text });
    return { applied: op, inverse: { op: 'delete_text', block: op.block, chars: [...op.text].map((_, k) => charId(id, k)) } };
  },
  delete_text(doc, op) {
    const block = doc.blocks[op.block] = migrated(blockOf(doc, op.block));
    if (!Array.isArray(op.chars) || !op.chars.length || op.chars.length > L.chars_per_insert) refuse('chars_invalid', `Delete between 1 and ${L.chars_per_insert} characters at a time.`);
    const key = stampKey(op.stamp), marked = [];
    for (const id of op.chars) {
      if (typeof id !== 'string' || !charExists(block, id)) refuse('anchor_missing', 'Those words are not in that block.', 409);
      const marks = block.deleted[id] ?? [];
      if (!marks.includes(key)) { block.deleted[id] = [...marks, key].sort(); marked.push(id); }
    }
    return { applied: op, inverse: marked.length ? { op: 'restore_text', block: op.block, chars: marked, of: op.stamp } : null };
  },
  restore_text(doc, op) {
    const block = doc.blocks[op.block] = migrated(blockOf(doc, op.block));
    if (!Array.isArray(op.chars) || !op.chars.length || !isStamp(op.of)) refuse('chars_invalid', 'Name the characters and the deletion to take back.');
    const key = stampKey(op.of), restored = [];
    for (const id of op.chars) {
      if (typeof id !== 'string' || !charExists(block, id)) refuse('anchor_missing', 'Those words are not in that block.', 409);
      const marks = block.deleted[id] ?? [];
      if (marks.includes(key)) {
        const left = marks.filter(mark => mark !== key);
        if (left.length) block.deleted[id] = left; else delete block.deleted[id];
        restored.push(id);
      }
    }
    return { applied: op, inverse: restored.length ? { op: 'delete_text', block: op.block, chars: restored } : null };
  },
  insert_block(doc, op, renames) {
    const id = mintedBlockId(op.stamp);
    if (doc.blocks[id]) refuse('stamp_reused', 'This operation stamp was already used for another block.', 409);
    if (Object.keys(doc.blocks).length >= L.blocks_per_document) refuse('document_too_large', `A document holds at most ${L.blocks_per_document} blocks.`);
    if (typeof op.key !== 'string' || !KEY.test(op.key)) refuse('key_invalid', 'A new block names its place.');
    if (op.text !== undefined && (typeof op.text !== 'string' || op.text.length > L.chars_per_insert)) refuse('text_invalid', `A new block starts with at most ${L.chars_per_insert} characters.`);
    const props = readProps(op.props);
    if (typeof op.block === 'string') renames.set(op.block, id);
    doc.blocks[id] = { key: op.key, pos: op.stamp, made: op.stamp, removed: null, format_version: SEQUENCE, deleted: {},
      runs: op.text ? [{ id: runIdFor(op.stamp), after: null, s: op.stamp, text: op.text }] : [],
      props: Object.fromEntries(Object.entries(props).map(([key, v]) => [key, { v: clone(v), s: op.stamp }])) };
    return { applied: { ...op, block: id }, inverse: { op: 'remove_block', block: id } };
  },
  remove_block(doc, op) {
    const block = blockOf(doc, op.block);
    // Last writer wins on the removed register, so two removals give the same stamp in either order.
    if (block.removed && compareStamps(op.stamp, block.removed.s) <= 0) return { applied: op, inverse: null };
    block.removed = { v: true, s: op.stamp };
    return { applied: op, inverse: { op: 'restore_block', block: op.block, guard: op.stamp } };
  },
  restore_block(doc, op) {
    const block = blockOf(doc, op.block);
    if (!block.removed?.v || (op.guard !== undefined && !sameStamp(block.removed.s, op.guard)) || compareStamps(op.stamp, block.removed.s) <= 0) return { applied: op, inverse: null };
    block.removed = { v: false, s: op.stamp };
    return { applied: op, inverse: { op: 'remove_block', block: op.block } };
  },
  move_block(doc, op) {
    const block = blockOf(doc, op.block);
    if (typeof op.key !== 'string' || !KEY.test(op.key)) refuse('key_invalid', 'A moved block names its new place.');
    if ((op.guard !== undefined && !sameStamp(block.pos, op.guard)) || compareStamps(op.stamp, block.pos) <= 0) return { applied: op, inverse: null };
    const prior = block.key;
    block.key = op.key; block.pos = op.stamp;
    return { applied: op, inverse: { op: 'move_block', block: op.block, key: prior, guard: op.stamp } };
  },
  set_block_props(doc, op) {
    const block = blockOf(doc, op.block);
    const props = readProps(op.props);
    if (op.guard !== undefined && !plainObject(op.guard)) refuse('props_invalid', 'A props guard names a stamp per prop.');
    const prior = {}, guard = {};
    for (const [key, value] of Object.entries(props)) {
      const held = block.props[key];
      if (op.guard && Object.hasOwn(op.guard, key) && !(op.guard[key] === null ? !held : held && sameStamp(held.s, op.guard[key]))) continue;
      if (held && compareStamps(op.stamp, held.s) <= 0) continue;
      prior[key] = held ? clone(held.v) : null;
      guard[key] = op.stamp;
      block.props[key] = { v: value === undefined ? null : clone(value), s: op.stamp };
    }
    if (Object.keys(block.props).length > L.props_per_block) refuse('props_invalid', `A block keeps at most ${L.props_per_block} props.`);
    return { applied: op, inverse: Object.keys(prior).length ? { op: 'set_block_props', block: op.block, props: prior, guard } : null };
  },
};
export const DOCUMENT_OPERATION_KINDS = Object.freeze(Object.keys(KINDS));

/**
 * Apply one batch of stamped operations made by `actor`. Answers the new document, the operations as applied (ids
 * repaired) and their inverses, newest last. A refused operation refuses the whole batch; the input is never changed.
 */
export function applyOperations(document, ops, { actor } = {}) {
  if (typeof actor !== 'string' || !actor || actor.length > L.actor_chars || !ACTOR.test(actor)) refuse('actor_invalid', 'Each batch names the editing session that made it.');
  if (!Array.isArray(ops) || !ops.length || ops.length > L.ops_per_batch) refuse('batch_invalid', `Send between 1 and ${L.ops_per_batch} operations at a time.`);
  const doc = openDocument(document);
  const renames = new Map(), applied = [], inverse = [];
  let last = null;
  for (const raw of ops) {
    if (!plainObject(raw) || !Object.hasOwn(KINDS, raw.op)) refuse('operation_unknown', 'That is not a document operation.');
    if (!isStamp(raw.stamp) || raw.stamp[1] !== actor) refuse('stamp_invalid', 'Each operation carries a stamp made by its own session.');
    if (last && compareStamps(raw.stamp, last) <= 0) refuse('stamp_invalid', 'The operations of a batch carry increasing stamps.');
    last = raw.stamp;
    const op = raw.op !== 'insert_block' && raw.block !== undefined && renames.has(raw.block) ? { ...raw, block: renames.get(raw.block) } : raw;
    const result = KINDS[op.op](doc, op, renames);
    applied.push(result.applied);
    if (result.inverse) inverse.push(result.inverse);
    doc.clock = Math.max(doc.clock, raw.stamp[0]);
  }
  if (itemCount(doc) > L.items_per_document) refuse('document_too_large', 'This document is larger than one edited document keeps.');
  return { document: doc, applied, inverse };
}

/** Give unstamped operations consecutive stamps after everything this document has seen. */
export function stampOperations(document, ops, actor) {
  let counter = document.clock;
  return ops.map(op => ({ ...op, stamp: [(counter += 1), actor] }));
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Longest increasing run of current positions, so a reorder moves the fewest blocks.
function stableIndexes(sequence) {
  const tails = [], previous = new Array(sequence.length).fill(-1), tailAt = [];
  sequence.forEach((value, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < value) lo = mid + 1; else hi = mid; }
    tails[lo] = value; tailAt[lo] = i; previous[i] = lo ? tailAt[lo - 1] : -1;
  });
  const keep = new Set();
  for (let i = tailAt[tails.length - 1] ?? -1; i >= 0; i = previous[i]) keep.add(i);
  return keep;
}

/**
 * The operations that turn what `document` shows into `blocks` ([{ id, text, props }], in order): removed blocks, new
 * and moved blocks placed between the blocks that keep their place (fewest moves first, every block placed again when
 * that is not enough), changed props and, per block, the words between the unchanged start and end. Answered stamped
 * by `actor` and checked by applying them.
 */
export function editsToward(document, blocks, actor) {
  const current = documentView(document);
  const currentById = new Map(current.map(block => [block.id, block]));
  const targetIds = new Set(blocks.map(block => block.id));
  const removed = current.filter(block => !targetIds.has(block.id)).map(block => ({ op: 'remove_block', block: block.id }));
  const surviving = blocks.filter(block => currentById.has(block.id));
  const order = new Map(current.map((block, index) => [block.id, index]));
  const keep = stableIndexes(surviving.map(block => order.get(block.id)));
  const survivingAt = new Map(surviving.map((block, index) => [block.id, index]));
  // Each block that does not keep its place gets a key between the placed block before it and the next kept one.
  const place = everyBlock => {
    const kept = block => !everyBlock && currentById.has(block.id) && keep.has(survivingAt.get(block.id));
    const nextKept = new Array(blocks.length).fill(null);
    for (let i = blocks.length - 1, next = null; i >= 0; i -= 1) { nextKept[i] = next; if (kept(blocks[i])) next = document.blocks[blocks[i].id].key; }
    let previous = null;
    return blocks.flatMap((block, i) => {
      if (kept(block)) { previous = document.blocks[block.id].key; return []; }
      const key = previous = keyBetween(previous, nextKept[i]);
      return [currentById.has(block.id) ? { op: 'move_block', block: block.id, key }
        : { op: 'insert_block', block: block.id, key, props: block.props ?? {}, ...(block.text ? { text: block.text } : {}) }];
    });
  };
  const content = [];
  for (const block of surviving) {
    const held = currentById.get(block.id);
    const changed = {};
    for (const key of new Set([...Object.keys(held.props), ...Object.keys(block.props ?? {})])) {
      if (!sameValue(held.props[key], block.props?.[key])) changed[key] = block.props?.[key] ?? null;
    }
    if (Object.keys(changed).length) content.push({ op: 'set_block_props', block: block.id, props: changed });
    const text = block.text ?? '';
    if (text === held.text) continue;
    const chars = blockCharacters(document.blocks[block.id]).filter(c => !c.deleted);
    let start = 0;
    while (start < chars.length && start < text.length && chars[start].ch === text[start]) start += 1;
    let end = 0;
    while (end < chars.length - start && end < text.length - start && chars[chars.length - 1 - end].ch === text[text.length - 1 - end]) end += 1;
    const gone = chars.slice(start, chars.length - end).map(c => c.id);
    for (let at = 0; at < gone.length; at += L.chars_per_insert) content.push({ op: 'delete_text', block: block.id, chars: gone.slice(at, at + L.chars_per_insert) });
    const added = text.slice(start, text.length - end);
    // Replacing words anchors the new ones after the words they replace, so taking the replacement back puts the old
    // words where they were, ahead of anything someone added after the new ones.
    if (added) content.push({ op: 'insert_text', block: block.id, after: gone.length ? gone.at(-1) : start ? chars[start - 1].id : null, text: added });
  }
  const attempt = everyBlock => stampOperations(document, [...removed, ...place(everyBlock), ...content], actor);
  // Inserted blocks are shown under their minted ids; the check reads them back by the ids they were proposed under.
  const shownAs = ops => {
    const result = applyOperations(document, ops, { actor });
    const proposed = new Map(result.applied.filter(op => op.op === 'insert_block').map((op, i) => [op.block, ops.filter(one => one.op === 'insert_block')[i].block]));
    return documentView(result.document).map(block => proposed.get(block.id) ?? block.id);
  };
  let fewest = null;
  try { fewest = attempt(false); } catch (error) { if (error?.code !== 'key_invalid') throw error; }
  if (fewest && (!fewest.length || sameValue(shownAs(fewest), blocks.map(block => block.id)))) return fewest;
  return attempt(true);
}

/** Keep one edit's inverses on a person's own undo stack (bounded by undo_depth); `group` joins it to the newest entry,
 *  so a run of typing is undone as one step. */
export function pushUndo(stack, inverse, { group = false } = {}) {
  if (!inverse.length) return stack;
  if (group && stack.length) return [...stack.slice(0, -1), [...stack.at(-1), ...inverse]];
  return [...stack, inverse].slice(-L.undo_depth);
}

/** The newest entry of the stack as operations to send (inverses newest first, stamped), and the stack without it. */
export function takeUndo(stack, document, actor) {
  if (!stack.length) return { ops: [], stack };
  return { ops: stampOperations(document, [...stack.at(-1)].reverse(), actor), stack: stack.slice(0, -1) };
}
