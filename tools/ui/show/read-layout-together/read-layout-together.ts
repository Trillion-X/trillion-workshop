// parts/ui/show/read-layout-together/read-layout-together.ts
//
// PURPOSE
//   Reads of the page's layout (an element's scrollHeight, its box) asked for by many parts during one render are
//   run together, once that render has finished writing the page, so the browser works out the layout once for all of
//   them instead of once per part. A board of a thousand cards each measuring its own text costs one layout, not a
//   thousand.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every read asked for in one task runs in the same flush, in the order asked, before the page is next painted.
//   2. A read cancelled before the flush (its part re-rendered or went away) never runs.
//   3. A read only reads the page and reports through state; one that writes the page would make the next read
//      work out the layout again, which is the cost this exists to remove.

const waiting: Array<() => void> = [];

function flush(): void {
  for (const read of waiting.splice(0)) read();
}

/** Run `read` together with every other read asked for in this task, after the render has written the page.
 *  Returns the cancel, ready to be a layout effect's cleanup. */
export function readLayoutTogether(read: () => void): () => void {
  let live = true;
  waiting.push(() => {
    if (live) read();
  });
  if (waiting.length === 1) queueMicrotask(flush);
  return () => {
    live = false;
  };
}
