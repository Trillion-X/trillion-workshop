// src/workspace/document-operation-sync.mjs
//
// PURPOSE
//   One editing session of a document kept as operations (src/workspace/document-operations.mjs) in the person's store
//   (src/native-workspace-records.mjs applyDocumentOperations, /work/api/records/document-operations). The session
//   holds the store's document at its version (`confirmed`) and this session's operations the store has not answered
//   yet (`pending`); what the editor shows is confirmed with pending applied. Every edit becomes operations by id, so
//   other people's and AIs' batches the store answers are applied under the pending ones without losing either.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One batch is in flight at a time and keeps its batch id until the store answers, so a retry after a lost reply
//      is answered with what the batch did instead of being applied twice.
//   2. Undo takes this session's own newest edit back (pushUndo/takeUndo): it never removes words someone else wrote.
//      Redo puts back what the newest undo took away, the same way; a new edit clears what could be redone.
//   3. A document the store refuses as newer than this build (schema_newer) is not opened here.
//   4. The transport is given: { read(query), apply(body), remove(body) }, each answering the store's reply or
//      throwing an error with its HTTP `status` (404: not kept yet; 409: changed meanwhile); nothing here names a route.
//   5. A block this session made keeps the id its editor gave it on screen, while the store holds it under the id
//      minted for it (src/workspace/document-operations.mjs invariant 2): the session translates both ways.
//   6. Cancel takes back only this session's edits: with nobody else's batch since it opened, the store's copy is
//      closed; otherwise each of its undo steps is sent, so other people's words stay.
//
//   blocksFromNodes(nodes) / nodesFromBlocks(view): a scene node list <-> the engine's { id, text, props } blocks.
//   sameBlocks(a, b): whether two block lists show the same thing (key order aside).
import { applyOperations, documentFromBlocks, documentView, editsToward, openDocument, pushUndo, takeUndo, DOCUMENT_LIMITS } from './document-operations.mjs';

// A node's words are the block text; its kind, other props and other fields are one prop each, so changing one of
// them is one register and the node comes back exactly.
const TEXT = 'text';
export function blocksFromNodes(nodes) {
  return nodes.map(({ id, props = {}, ...rest }) => {
    const { [TEXT]: text = '', ...others } = props;
    return { id, text: typeof text === 'string' ? text : '', props: {
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined).map(([key, value]) => [`node.${key}`, value])),
      ...Object.fromEntries(Object.entries(others).filter(([, value]) => value !== undefined).map(([key, value]) => [`props.${key}`, value])),
    } };
  });
}
export function nodesFromBlocks(view) {
  return view.map(({ id, text, props }) => {
    const node = { id, props: { [TEXT]: text } };
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('node.')) node[key.slice(5)] = value;
      else if (key.startsWith('props.')) node.props[key.slice(6)] = value;
    }
    return node;
  });
}

// A Write-screen page is saved as { children, edges?, camera?, definitions? } (parts/documents CompositionContent): its
// children are the blocks, so a page opens in the operation model by the same two functions as a file's blocks. The
// rest of the page (edges, camera, definitions) is not words, so it stays with the saved page and is laid back on it.
export const blocksFromPage = content => blocksFromNodes(Array.isArray(content?.children) ? content.children : []);
export const pageFromBlocks = (view, content = {}) => ({ ...content, children: nodesFromBlocks(view) });

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const sameBlocks = (a, b) => JSON.stringify(canonical(a.map(({ id, text, props }) => ({ id, text, props }))))
  === JSON.stringify(canonical(b.map(({ id, text, props }) => ({ id, text, props }))));

const randomLetters = count => Array.from(crypto.getRandomValues(new Uint8Array(count)), byte => String.fromCharCode(97 + (byte % 26))).join('');

export function documentOperationSession({ address, baseIdentity, seed, transport, onChange = () => {}, actor = `s${randomLetters(11)}`, now = () => Date.now() }) {
  let confirmed = documentFromBlocks(seed);
  let version = 0, onStore = false, undoStack = [], redoStack = [], queued = [], inFlight = null, local = confirmed, failure = null, closed = false;
  let lastEditAt = -Infinity, othersEdited = false;
  const minted = new Map(), proposed = new Map();
  const shown = () => documentView(local).map(block => ({ ...block, id: proposed.get(block.id) ?? block.id }));
  // source: 'local' (this session's own edit, already on screen), 'store' (the store's answer or someone else's batch)
  // or 'undo' (this session took an edit back).
  const changed = source => onChange({ view: shown(), source, version, pending: queued.length + (inFlight?.ops.length ?? 0), failure });
  // Pending operations that no longer apply to the store's document (a block another batch took the proposed id of)
  // are dropped and said, never kept on screen as if they were saved.
  const rebuild = () => {
    try {
      local = confirmed;
      for (const ops of [...(inFlight ? [inFlight.ops] : []), ...(queued.length ? [queued] : [])]) local = applyOperations(local, ops, { actor }).document;
    } catch (error) {
      failure = error; queued = []; local = confirmed;
      if (inFlight) { try { local = applyOperations(confirmed, inFlight.ops, { actor }).document; } catch { local = confirmed; } }
    }
  };
  const absorb = reply => {
    if (reply.document) confirmed = openDocument(reply.document);
    else for (const entry of reply.committed ?? []) if (entry.version > version) {
      confirmed = applyOperations(confirmed, entry.ops, { actor: entry.actor }).document;
      if (entry.actor !== actor) othersEdited = true;
    }
    if (reply.document && reply.version > 0) othersEdited = true;
    version = reply.version;
    onStore = true;
  };
  const batchId = () => `${actor}-${randomLetters(12)}`;

  async function flush() {
    while (!closed && !inFlight && queued.length) {
      inFlight = { batch_id: batchId(), ops: queued.slice(0, DOCUMENT_LIMITS.ops_per_batch) };
      queued = queued.slice(inFlight.ops.length);
      for (;;) {
        try {
          const body = { address, batch_id: inFlight.batch_id, actor, base_version: version, base_identity: baseIdentity, ops: inFlight.ops, ...(onStore ? {} : { seed }) };
          absorb(await transport.apply(body));
          inFlight = null; failure = null;
          rebuild(); changed('store');
          break;
        } catch (error) {
          // Not kept by the store yet: send the blocks it opens from, under the same batch id.
          if (error?.status === 404 && onStore) { onStore = false; continue; }
          failure = error;
          // A refused batch can never be applied as it is: the store's document is read again and this session's
          // unsent words are shown as refused rather than kept as if saved. A lost reply keeps the batch to retry.
          if (error?.status && error.status < 500) { inFlight = null; queued = []; await sync(); }
          else { rebuild(); changed('store'); }
          return;
        }
      }
    }
  }
  async function sync() {
    if (closed) return;
    const reply = await transport.read({ address, ...(onStore ? { since: version } : {}) });
    if (reply.found && reply.base_identity !== baseIdentity) {
      failure = Object.assign(new Error('Someone is editing an earlier saved version of this document.'), { code: 'base_changed', status: 409 });
      closed = true; changed('store'); return;
    }
    if (reply.found) absorb(reply);
    rebuild(); changed('store');
  }
  const record = ops => {
    if (!ops.length) return;
    const result = applyOperations(local, ops, { actor });
    ops.forEach((op, i) => { if (op.op === 'insert_block') { minted.set(op.block, result.applied[i].block); proposed.set(result.applied[i].block, op.block); } });
    local = result.document;
    queued = [...queued, ...ops];
    return result;
  };
  return {
    actor,
    open: sync,
    sync: async () => { await sync(); await flush(); },
    view: shown,
    /** Make the shown document `blocks` ({ id, text, props }), as operations this session can undo. */
    edit(blocks) {
      if (closed) return;
      const result = record(editsToward(local, blocks.map(block => ({ ...block, id: minted.get(block.id) ?? block.id })), actor));
      if (!result) return;
      const at = now();
      undoStack = pushUndo(undoStack, result.inverse, { group: at - lastEditAt < DOCUMENT_LIMITS.undo_group_ms });
      redoStack = [];
      lastEditAt = at;
      changed('local');
      return flush();
    },
    canUndo: () => undoStack.length > 0,
    undo() {
      if (closed || !undoStack.length) return;
      const taken = takeUndo(undoStack, local, actor);
      undoStack = taken.stack;
      // What undoing did is what redo takes back: the same inverse mechanism, so a redo also leaves other people's words.
      redoStack = pushUndo(redoStack, record(taken.ops)?.inverse ?? []);
      lastEditAt = -Infinity;
      changed('undo');
      return flush();
    },
    canRedo: () => redoStack.length > 0,
    /** Put back the edit this session's newest undo took away (a new edit clears what could be redone). */
    redo() {
      if (closed || !redoStack.length) return;
      const taken = takeUndo(redoStack, local, actor);
      redoStack = taken.stack;
      undoStack = pushUndo(undoStack, record(taken.ops)?.inverse ?? []);
      lastEditAt = -Infinity;
      changed('undo');
      return flush();
    },
    /** Take back this session's edits and stop: invariant 5. */
    async cancel() {
      await flush();
      if (onStore && !othersEdited && !inFlight && !queued.length) {
        closed = true;
        return transport.remove({ address, expected_version: version }).then(answer => ({ ...answer, cancelled: true }), async error => {
          if (error?.status !== 409) throw error;
          closed = false; othersEdited = true; await sync();
          return this.cancel();
        });
      }
      while (undoStack.length) {
        const taken = takeUndo(undoStack, local, actor);
        undoStack = taken.stack;
        record(taken.ops);
      }
      await flush();
      closed = true;
      return { removed: false, cancelled: true };
    },
    /** Once the document is saved as a file version: close it in the store when only this session edited it; with
     *  other editors it stays open for them (src/native-workspace-records.mjs drops idle ones). */
    async close() {
      closed = true;
      if (!onStore || inFlight || queued.length || othersEdited) return { removed: false };
      return transport.remove({ address, expected_version: version }).catch(error => ({ removed: false, error }));
    },
    state: () => ({ version, pending: queued.length + (inFlight?.ops.length ?? 0), failure, onStore }),
  };
}
