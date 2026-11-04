// src/namespace-view.mjs
//
// PURPOSE
//   An in-memory copy of the last part of every name a person keeps (namespace_names), held beside their store, so a
//   search for words in names reads memory at memory speed instead of every row of the table. Each block of names is
//   one string of their lowercased last parts, searched with the engine's own substring search; a hit is a row id that
//   the store then reads, so what is answered always comes from the table itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The table is the truth. The view only proposes row ids; every answer is read back from namespace_names, so a
//      name removed since is never answered (its row is gone) and a row's current identity is the one shown.
//   2. A name's text never changes under one row id (the name is the row's key; a rename is a delete and an insert).
//      So rows added since the view was read are exactly those with a larger row id, and are read by that range alone.
//   3. Any delete, or any write that is not adding names (an account's rows moved in with their own row ids), marks the
//      view stale (readNamesAgain), because SQLite may hand a deleted top row id to the next
//      insert; a stale view is read again whole on its next use, never patched.
//   4. Memory is bounded by `most_bytes` (namespace-view.json). A person with more names than fit is searched by the
//      table as before (null from candidates); the bound is DATA, never a count of names in code.
//   5. Nothing here names a kind of file or a product: it holds row ids and text.
//
// KEY CONCEPTS
//   block      up to `block_names` names: their row ids (ascending), one string of their lowercased last parts joined by
//              a line break, and where each starts in it; a name added marks only the last block's string to be joined again
//   candidates the row ids whose last part holds every asked word, in row order, at most `limit`
//
import settings from './namespace-view.json' with { type: 'json' };

const views = new WeakMap();
const SEPARATOR = '\n';
const textOf = name => name.slice(name.lastIndexOf('/') + 1).toLowerCase().replace(/['’\n]/g, '');

// The last index whose value is <= at, in an ascending Int32Array (the name holding a found position).
function holding(starts, count, at) {
  let low = 0, high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= at) low = middle; else high = middle - 1;
  }
  return low;
}

function makeBlock() {
  return { rows: new Int32Array(settings.block_names), starts: new Int32Array(settings.block_names), count: 0, parts: [], text: '', length: 0 };
}

function viewOf(sql) {
  let blocks = [];
  let lastRow = -Infinity;
  let bytes = 0;
  let state = 'unread';
  let tooBig = false;

  const add = (row, name) => {
    let block = blocks.at(-1);
    if (!block || block.count === settings.block_names) { block = makeBlock(); blocks.push(block); }
    const part = textOf(name);
    block.rows[block.count] = row;
    block.starts[block.count] = block.length;
    block.parts.push(part);
    block.length += part.length + 1;
    block.count += 1;
    block.text = null;
    // A string of Latin-1 characters takes one byte each, any other two; a row id and a start take four bytes each.
    bytes += (/[^\u0000-\u00ff]/.test(part) ? part.length * 2 : part.length) + 1 + 8;
    lastRow = row;
  };

  const readSince = () => {
    for (const { row, name } of sql.exec('SELECT rowid AS row, name FROM namespace_names WHERE rowid > ? ORDER BY rowid', lastRow === -Infinity ? -1 : lastRow)) {
      // A row id past what four bytes hold is past what this view keeps, like a store past its memory bound.
      if (row > 0x7fffffff) { tooBig = true; blocks = []; bytes = 0; return; }
      add(row, name);
      // Over the bound the view holds nothing until a delete makes it stale and it is read again.
      if (bytes > settings.most_bytes) { tooBig = true; blocks = []; bytes = 0; return; }
    }
  };

  // The view as of now: read whole when unread or stale, else only the rows added since.
  function current() {
    if (state === 'read' && tooBig) return false;
    if (state !== 'read') { blocks = []; lastRow = -Infinity; bytes = 0; tooBig = false; }
    readSince();
    state = 'read';
    for (const block of blocks) {
      if (block.text !== null) continue;
      block.text = block.parts.join(SEPARATOR) + SEPARATOR;
      // A full block never takes another name: its last parts are read back out of its one string.
      if (block.count === settings.block_names) block.parts = null;
    }
    return !tooBig;
  }

  return {
    stale() { state = 'stale'; },
    // Row ids whose last part holds every word (already lowercased), at most `limit`; null when the view is over its
    // memory bound and the table must be searched instead.
    candidates(terms, limit) {
      if (!current()) return null;
      if (!terms.length) return [];
      const [first, ...rest] = [...terms].sort((a, b) => b.length - a.length);
      const found = [];
      for (const block of blocks) {
        const { text } = block;
        let lastName = -1;
        for (let at = text.indexOf(first); at !== -1; at = text.indexOf(first, at + 1)) {
          const index = holding(block.starts, block.count, at);
          if (index === lastName) continue;
          lastName = index;
          const part = block.parts?.[index] ?? text.slice(block.starts[index], (index + 1 < block.count ? block.starts[index + 1] : block.length) - 1);
          if (rest.every(term => part.includes(term))) {
            found.push(block.rows[index]);
            if (found.length >= limit) return found;
          }
        }
      }
      return found;
    },
    held() { current(); return { names: blocks.reduce((sum, block) => sum + block.count, 0), blocks: blocks.length, bytes, too_big: tooBig }; },
  };
}

/** The one view of the names in this store's database (one per database handle). */
export function namespaceView(sql) {
  let view = views.get(sql);
  if (!view) { view = viewOf(sql); views.set(sql, view); }
  return view;
}

/** Every place that deletes from namespace_names, or writes it other than by adding names, calls this, so the next search
 * reads the names again. */
export const readNamesAgain = sql => views.get(sql)?.stale();
