// parts/documents/do-work/page-operation-writes.mjs
//
// PURPOSE
//   A Write-screen page is saved as one record ({ children, edges?, camera?, definitions? }) by whole-document writes
//   that are checked against the record's last identity, so two editors of one page meet as a conflict. This turns each
//   save into operations kept in the person's store (src/workspace/document-operation-sync.mjs) so the editors meet as
//   a merge: what a save writes is the page with other editors' words laid under this one's edits, and a change that
//   only others made is written back as the page and announced to the screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the page's children are operations (blocksFromPage); edges, camera and definitions are this editor's and
//      travel with the content it writes (pageFromBlocks lays the merged children back on it).
//   2. A page the store cannot open as operations is saved exactly as before: `open` answers null and the caller writes
//      the whole page unchanged. A page is never lost to the merge.
//   3. The write the caller makes for a merge is the only write; this module names no route (the transport is given).
import { blocksFromPage, documentOperationSession, pageFromBlocks, sameBlocks } from '#workspace/document-operation-sync.mjs';

/** The page's address among document operations: its record label, kept apart from file documents by its prefix. */
export const pageOperationsAddress = label => `page:${label}`;

export async function openPageOperations({ address, seed, transport, write, onRemote }) {
  const session = documentOperationSession({ address, baseIdentity: 'page', seed: blocksFromPage(seed), transport });
  try { await session.open(); } catch { return null; }
  let latest = seed;
  return {
    session,
    /** The page to save for `content`: this editor's edits as operations, merged with what others kept meanwhile. */
    async merge(content) {
      latest = content;
      await session.edit(blocksFromPage(content));
      await session.sync();
      const view = session.view();
      if (sameBlocks(view, blocksFromPage(content))) return { content, merged: false };
      latest = pageFromBlocks(view, content);
      return { content: latest, merged: true };
    },
    /** Others' operations arrived: when they changed the page, write it and tell the screen to read it. */
    async arrive() {
      await session.sync();
      const view = session.view();
      if (sameBlocks(view, blocksFromPage(latest))) return false;
      latest = pageFromBlocks(view, latest);
      await write(latest);
      onRemote();
      return true;
    },
    close: () => session.close(),
  };
}
