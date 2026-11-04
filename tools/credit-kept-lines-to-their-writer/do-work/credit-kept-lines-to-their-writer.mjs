// tools/credit-kept-lines-to-their-writer/do-work/credit-kept-lines-to-their-writer.mjs
//
// tool:credit-kept-lines-to-their-writer, run as a function (tools/records-door do-work/run-an-export.mjs): given the
// versions of a text (oldest first) and who wrote each, credits every line still in the newest version to whoever first
// wrote it, by src/kept-work.mjs keptWork unchanged. It keeps nothing.
//
//   creditKeptLines(input) -> { by: { [writer]: lines }, kept, versions }
//   input: { versions: [{ by, text }] }
import { keptWork } from '../src/kept-work.mjs';

export function creditKeptLines(input = {}) {
  const { versions } = input ?? {};
  if (!Array.isArray(versions)) throw new Error('versions is a list of { by, text }, oldest first.');
  return keptWork(versions);
}
