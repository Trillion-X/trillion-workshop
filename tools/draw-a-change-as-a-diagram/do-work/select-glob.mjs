// tools/draw-a-change-as-a-diagram/do-work/select-glob.mjs
//
// The one way a selector with `*` wildcards becomes a test, shared by every place a graph document's inputs or
// corrections are selected by name (./graph-patch.mjs corrections, ./author-input.mjs path rules).
//
// Invariants: `*` matches any run of characters including none (and including `/`); every other character matches only
// itself; the whole text must match; the wildcard character is passed in, never named here.

/** A test `(text) => boolean` for `selector`, where `wildcard` stands for any run of characters. */
export function selectorTest(selector, wildcard = '*') {
  const pattern = new RegExp(`^${selector.split(wildcard).map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'u');
  return (text) => pattern.test(text);
}
