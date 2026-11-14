// parts/ui/show/responses/text-part.ts
//
// PURPOSE
//   Some words of a thing, kept so they can be found again: a selection inside a thing's element becomes a text-range
//   part (src/responses.mjs) holding the words themselves, a little of what comes before and after them, and where
//   they start and end in the thing's text. Finding them again tries the kept place first, then the words with their
//   surroundings, then the words alone, so a part still finds its words after the text around it changed. This is the
//   W3C Web Annotation TextQuoteSelector with a TextPositionSelector (https://www.w3.org/TR/annotation-model/#selectors).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reads only the text of the element it is given; knows no screen, record or product word.
//   2. A selection that is empty, only spaces, or reaches outside the element gives no part.
//   3. The words are kept at most QUOTE characters; the surroundings CONTEXT characters each side.

/** Some words of a thing: the shape every store keeps under `part` (src/responses.mjs partFrom). */
export type TextPart = { kind: 'text-range'; quote: string; prefix: string; suffix: string; start: number; end: number };

const QUOTE = 1000;
const CONTEXT = 32;

/** How many characters of `root`'s text come before the point (node, offset) inside it. */
function offsetIn(root: Node, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The part a range picks inside `root`, or null when it picks nothing or reaches outside it. */
export function textPartOf(root: Element, range: Range): TextPart | null {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const whole = root.textContent ?? '';
  const start = offsetIn(root, range.startContainer, range.startOffset);
  const end = offsetIn(root, range.endContainer, range.endOffset);
  const quote = whole.slice(start, end);
  if (!quote.trim()) return null;
  return {
    kind: 'text-range',
    quote: quote.slice(0, QUOTE),
    prefix: whole.slice(Math.max(0, start - CONTEXT), start),
    suffix: whole.slice(end, end + CONTEXT),
    start,
    end: Math.min(end, start + QUOTE),
  };
}

/** Where a kept part's words are now in `whole`: [start, end), or null when they are gone. */
export function findTextPart(whole: string, part: Pick<TextPart, 'quote' | 'prefix' | 'suffix' | 'start'>): [number, number] | null {
  if (!part.quote) return null;
  if (whole.slice(part.start, part.start + part.quote.length) === part.quote) return [part.start, part.start + part.quote.length];
  const withContext = whole.indexOf(`${part.prefix}${part.quote}${part.suffix}`);
  if (withContext >= 0) return [withContext + part.prefix.length, withContext + part.prefix.length + part.quote.length];
  const alone = whole.indexOf(part.quote);
  return alone >= 0 ? [alone, alone + part.quote.length] : null;
}
