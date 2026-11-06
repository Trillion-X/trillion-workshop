// tools/check-against-a-persons-rules-and-verdicts/do-work/spoken-origins.mjs
//
// Purpose
//   Says where each unit's words come from, so a rule written for words someone added can hold, not fail, on words the
//   person actually said. The caller hands in the units and the recording spans the piece cites, each with its
//   transcript text ({ clip, from, to, speaker_verified?, text }); this file reads no file. A unit leaves with
//   `facts.origin` and, when it is the person's words, `facts.span` ({ clip, from, to }), which a rule row's `when` and
//   `held_when` read through judge-words (do-work/rules-and-verdicts.mjs `check`).
//
// Non-negotiable invariants
//   1. A unit is `own-words` only when every one of its words is literally in one cited span, in order, both read through
//      the one fold the caller declares (the fold of the person's rule document, tools/where-a-person-stands
//      artifact-ref.mjs foldWith). A capital at the start of a sentence or a curly quote is not a word the person did not
//      say; an added, dropped or changed word is. The literal match is tools/pin-files-by-content literalPieces, the one
//      owner of finding a text's literal pieces in source bytes.
//   2. A span whose speaker no one has checked (speaker_verified false) gives `unverified-speaker`, so its words are
//      judged as added words, never softened. Verified spans are tried first.
//   3. Every other unit is `added-words`. A JSON view is not words and is returned as it came.
//   4. The origin words are DATA in read-data/words.json `origins`, so a caller's rows name them, never this file. A
//      person whose rows name their origins in their own words (their settings' `origin_words`, the same three keys)
//      passes them as `origins`, so their `held_when` rows hold where the words are theirs.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { literalPieces } from '../../pin-files-by-content/do-work/verify-source-spans.mjs';
import { foldWith } from '../../where-a-person-stands/do-work/artifact-ref.mjs';
import WORDS from '../read-data/words.json' with { type: 'json' };

/**
 * Each text unit with its origin, read from the spans it may come from. `fold` is a DATA fold block or a function
 * foldWith made; `origins` ({ own, added, unverified }) the words the person's rows use. Returns new units; `facts`
 * keeps whatever facts the unit already had.
 */
export function withSpokenOrigins(units, spans, { fold, origins = WORDS.origins } = {}) {
  const folded = typeof fold === 'function' ? fold : foldWith(fold);
  const ordered = [...spans.filter(span => span.speaker_verified !== false), ...spans.filter(span => span.speaker_verified === false)];
  return units.map(unit => {
    if (unit.view !== undefined) return unit;
    const facts = unit.facts && typeof unit.facts === 'object' ? unit.facts : {};
    const span = ordered.find(candidate => {
      const { pieces, unbound } = literalPieces(folded(unit.text), Buffer.from(folded(String(candidate.text ?? '')), 'utf8'));
      return pieces.length > 0 && unbound.length === 0;
    });
    if (!span) return { ...unit, facts: { ...facts, origin: origins.added } };
    return { ...unit, facts: { ...facts, origin: span.speaker_verified === false ? origins.unverified : origins.own,
      span: { clip: span.clip, from: span.from ?? null, to: span.to ?? null } } };
  });
}
