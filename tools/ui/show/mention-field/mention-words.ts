// parts/ui/show/mention-field/mention-words.ts
//
// PURPOSE
//   What a message's text says, read through the documents part's token model (parts/documents/read-data/
//   inline-tokens.ts, the one owner of `⟦ref:…⟧` mentions): each thing it mentions, and the words as a person reads
//   them, a mention as `@name`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The token syntax lives only in the documents part; this file only reads its runs.
//   2. Each mention is listed once, in the order it was first written, as { kind, value, label }.

import { parseInlineRuns, type Ref } from '../../../documents/read-data/inline-tokens.ts';

export type Mention = Pick<Ref, 'kind' | 'value' | 'label'>;

/** Every mention in the text, once each, in the order first written. */
export function refsIn(text: string): Mention[] {
  const seen = new Set<string>();
  return parseInlineRuns(text).flatMap(run => {
    if (run.type !== 'ref') return [];
    const key = `${run.kind}\u0000${run.value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ kind: run.kind, value: run.value, label: run.label }];
  });
}

/** The text as a person reads it: each mention as `@name`. */
export function plainWords(text: string): string {
  return parseInlineRuns(text).map(run => (run.type === 'text' ? run.text : `@${run.label}`)).join('');
}
