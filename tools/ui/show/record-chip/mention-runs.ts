// parts/ui/show/record-chip/mention-runs.ts
//
// PURPOSE
//   The one rule for finding the mentions a kept message carries beside its words: a message is kept as a person reads
//   it (`@Sam, look`) with its mentions ({ kind, value, label }) beside it, and drawing it splits the words into
//   plain text and those mentions, each drawn as its live chip (RecordChip.tsx). Zero DOM and zero React, so every rule
//   here is testable on its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `mentionRuns` never drops or reorders words: joining its text runs and each mention's `@label` gives the words
//      back exactly.
//   2. Each mention is found at its first `@label` not already taken; longer labels are matched first, so `@Ann Lee`
//      is never read as `@Ann`. A mention whose `@label` is not in the words is not drawn.
//   3. Nothing here names a kind; `kind` and `value` travel as DATA for the chip.

/** A mention as a kept message carries it beside its words: { kind, value, label }. */
export type KeptMention = { kind: string; value: string; label: string };

/** The mentions a kept message carries (a list read from stored JSON), each a well-formed { kind, value, label }. */
export function keptMentions(listed: unknown): KeptMention[] {
  return Array.isArray(listed) ? listed.filter((one): one is KeptMention => typeof one?.kind === 'string' && typeof one?.value === 'string' && typeof one?.label === 'string') : [];
}

/** Words as plain text and the mentions they carry, in order. */
export type MentionRun = { type: 'text'; text: string } | ({ type: 'mention' } & KeptMention);

/**
 * Words kept as a person reads them (`@Sam, look`) split into plain text and the mentions kept beside them: each
 * mention is found at its first `@label` not already taken, longest name first so `@Ann Lee` is never read as `@Ann`;
 * a mention whose `@label` is not in the words is not drawn. Joining the text runs and each mention's `@label` gives
 * the words back exactly.
 */
export function mentionRuns(text: string, mentions: readonly KeptMention[] = []): MentionRun[] {
  const taken: { start: number; end: number; mention: KeptMention }[] = [];
  for (const mention of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    if (!mention.label) continue;
    const needle = `@${mention.label}`;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (!taken.some(span => at < span.end && end > span.start)) { taken.push({ start: at, end, mention }); break; }
    }
  }
  taken.sort((a, b) => a.start - b.start);
  const runs: MentionRun[] = [];
  let last = 0;
  for (const span of taken) {
    if (span.start > last) runs.push({ type: 'text', text: text.slice(last, span.start) });
    runs.push({ type: 'mention', kind: span.mention.kind, value: span.mention.value, label: span.mention.label });
    last = span.end;
  }
  if (last < text.length) runs.push({ type: 'text', text: text.slice(last) });
  return runs;
}

