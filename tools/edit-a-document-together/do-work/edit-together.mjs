// tools/edit-a-document-together/do-work/edit-together.mjs
//
// One document edited by several people and AIs at once, as one run of the document engine (document-operations.mjs):
// each editor's copy of the starting `blocks` is turned into that editor's own operations, the batches are merged in
// every order they could arrive in, and the document they all give comes back. `undo` names one editor whose edit is
// then taken back: only the words, blocks and props that editor changed, never another editor's words among them.
// Nothing is kept after the run: send the same blocks and edits again for the same document.
//
// Input:
//   blocks  [{ id, text?, props? }]           the document every editor started from, in order
//   edits   [{ by, blocks: [{ id, text?, props? }] }]
//                                             what each editor (by: a session name, letters, digits and :._~@-) made
//                                             their copy into; a block with a new id is a new block, a block left out
//                                             is removed
//   undo?   by                                the editor whose edit is taken back after the merge
// Answers { document, same_in_every_order, orders_checked, edits: [{ by, operations }], undone? }.
// Refused: no blocks or no edits, more than 6 editors (every order of them is checked), an editor named twice, an undo
// naming no editor here, and whatever the engine refuses (its code and message).
import { applyOperations, documentFromBlocks, documentView, editsToward, pushUndo, takeUndo } from './document-operations.mjs';

const MOST_EDITORS = 6;

function orders(count) {
  if (count <= 1) return [[...Array(count).keys()]];
  return orders(count - 1).flatMap(order => Array.from({ length: count }, (_, at) => [...order.slice(0, at), count - 1, ...order.slice(at)]));
}

export function editADocumentTogether({ blocks, edits, undo } = {}) {
  if (!Array.isArray(blocks)) throw new Error('Give blocks: the document every editor started from, as [{ id, text, props }].');
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('Give edits: [{ by, blocks }], one per editor, each the blocks that editor made their copy into.');
  if (edits.length > MOST_EDITORS) throw new Error(`Give at most ${MOST_EDITORS} edits: every order they could arrive in is checked.`);
  const names = new Set();
  edits.forEach((edit, index) => {
    if (typeof edit?.by !== 'string' || !edit.by) throw new Error(`Edit ${index} needs by: the name of the editor who made it.`);
    if (names.has(edit.by)) throw new Error(`${edit.by} is named by two edits; give each editor one edit.`);
    if (!Array.isArray(edit.blocks)) throw new Error(`Edit ${index} (${edit.by}) needs blocks: what that editor made the document into.`);
    names.add(edit.by);
  });
  if (undo !== undefined && !names.has(undo)) throw new Error(`undo names ${JSON.stringify(undo)}, who made no edit here; name one of ${[...names].join(', ')}.`);
  try {
    const start = documentFromBlocks(blocks);
    const batches = edits.map(edit => ({ by: edit.by, ops: editsToward(start, edit.blocks, edit.by) }));
    const merged = order => order.reduce((state, at) => {
      const { by, ops } = batches[at];
      if (!ops.length) return state;
      const result = applyOperations(state.document, ops, { actor: by });
      return { document: result.document, undo: { ...state.undo, [by]: pushUndo(state.undo[by] ?? [], result.inverse) } };
    }, { document: start, undo: {} });
    const every = orders(batches.length);
    const first = merged(every[0]);
    const shown = JSON.stringify(documentView(first.document));
    const same = every.every(order => JSON.stringify(documentView(merged(order).document)) === shown);
    const answer = { same_in_every_order: same, orders_checked: every.length, edits: batches.map(({ by, ops }) => ({ by, operations: ops.length })) };
    if (undo === undefined) return { document: documentView(first.document), ...answer };
    const { ops } = takeUndo(first.undo[undo] ?? [], first.document, undo);
    const after = ops.length ? applyOperations(first.document, ops, { actor: undo }).document : first.document;
    return { document: documentView(after), ...answer, undone: { by: undo, operations: ops.length } };
  } catch (error) {
    if (error?.code) throw new Error(`${error.message} (${error.code})`);
    throw error;
  }
}
