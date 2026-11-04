// parts/command-palette/show/match-ranges.ts
//
// PURPOSE
//   Where the words typed sit in a result's words, as the inclusive [start, end] character ranges the palette draws marked.
//   A result that arrives with its own ranges (`matches` on its row) is drawn from those; every other result is marked
//   from the words typed, so a match shows whichever place the result came from.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Each space-separated word typed is looked for in `text` without regard to case; every place it occurs is marked.
//   2. Ranges that overlap or touch are joined into one, in order, so the palette never marks a character twice.
//   3. Ranges index the original JavaScript string (UTF-16), even when lowercasing expands a character.
//   4. Nothing here knows a source, a kind of result or a screen.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export type MatchRange = readonly [number, number];

function lowercaseWithSourceOffsets(text: string): {lower: string; sourceStarts: number[]; sourceEnds: number[]} {
  const lower = text.toLowerCase();
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let sourceOffset = 0;
  for (const character of text) {
    const folded = character.toLowerCase();
    const sourceEnd = sourceOffset + character.length - 1;
    for (let unit = 0; unit < folded.length; unit += 1) {
      sourceStarts.push(sourceOffset);
      sourceEnds.push(sourceEnd);
    }
    sourceOffset += character.length;
  }
  return {lower, sourceStarts, sourceEnds};
}

export function matchRanges(query: string, text: string): MatchRange[] {
  const {lower, sourceStarts, sourceEnds} = lowercaseWithSourceOffsets(text);
  const found: [number, number][] = [];
  for (const word of new Set(query.toLowerCase().split(/\s+/).filter(Boolean))) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
      const end = at + word.length - 1;
      const startOffset = sourceStarts[at];
      const endOffset = sourceEnds[end];
      if (startOffset !== undefined && endOffset !== undefined) found.push([startOffset, endOffset]);
    }
  }
  found.sort((left, right) => left[0] - right[0]);
  return found.reduce<[number, number][]>((joined, range) => {
    const last = joined[joined.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else joined.push(range);
    return joined;
  }, []);
}
