// packages/group/do-work/board-subject-bag.ts
//
// The board SUBJECT projection — the pure core that turns board members into the text an
// Ask-AI / producer action acts on (what the instruction template reads as `{typed.text}`
// and its id-annotated sibling). ONE generic engine (`subjectBag`) folds members → lines
// via an INJECTED per-member formatter, so every projection (plain text, id-annotated for
// edit-in-place, a future cluster-tagged variant, …) is DATA — a formatter — never a new
// code branch (L069 / L090 / enum-dissolution).
//
// The board's inline whole-board subject is exactly `subjectBag(nonHidden, plainLine)`;
// EDIT-IN-PLACE (Flavor B) is `subjectBag(nonHidden, idAnnotatedLine)` so the agent can
// ECHO each note's stable `memberId`, and the reconcile consume seam edits that note IN
// PLACE (position preserved) instead of regenerating the whole board. Adding a projection
// never touches this file — you pass a different `format`.
//
// Pure, zero-I/O, framework-agnostic leaf: safe to unit-test in isolation and to compose
// from the React panel or any future host. Mirrors the exact filters the panel already
// applies (hidden cards excluded — off-canvas content must never leak into a run the user
// can't see; size-capped so a thousand-card board can't blow the prompt).

/** The minimal shape the subject projection needs from a board member. */
export interface SubjectMember {
  memberId: string;
  text?: string | null;
  html?: string | null;
  extra?: { hidden?: boolean | null } | null;
}

/** Same defuse-the-pathological cap the panel uses for `typed.text` (MAX_SUBJECT_CHARS). */
export const DEFAULT_MAX_SUBJECT_CHARS = 200_000;

/**
 * The SSOT plain-text extractor for a member: `text`, else tag-stripped `html`, else ''.
 * Every projection composes from this so "what is a note's text" is defined once.
 */
export function memberText(it: SubjectMember): string {
  return (it.text ?? (it.html ? it.html.replace(/<[^>]+>/g, '').trim() : '')) || '';
}

/** Projection: just the note text (the shipped Flavor-A / default subject line). */
export const plainLine = (it: SubjectMember): string => memberText(it);

/**
 * Projection: `[memberId] text` — carries each note's stable id so the agent can echo it
 * for edit-in-place (Flavor B). Empty-text members project to '' (dropped by `subjectBag`),
 * so an id never appears without content.
 */
export const idAnnotatedLine = (it: SubjectMember): string => {
  const t = memberText(it);
  return t.trim() ? `[${it.memberId}] ${t}` : '';
};

/**
 * The generic subject engine: fold the VISIBLE members → one string via an injected
 * per-member `format` projection. Hidden cards never leak; empty lines drop; the result
 * is size-capped. Blind to WHAT the projection is — that is the whole point (L069/L090):
 * a new projection is a new formatter passed in, with zero change here.
 *
 * @param members  board members (note cards; connectors should be filtered by the caller)
 * @param format   per-member projection (default {@link plainLine})
 * @param maxChars hard cap on the joined result (default {@link DEFAULT_MAX_SUBJECT_CHARS})
 */
export function subjectBag(
  members: readonly SubjectMember[],
  format: (m: SubjectMember) => string = plainLine,
  maxChars: number = DEFAULT_MAX_SUBJECT_CHARS,
): string {
  const lines = members
    .filter((m) => m.extra?.hidden !== true)
    .map(format)
    .filter((l) => l.trim().length > 0);
  const joined = lines.join('\n\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

/** An explicit selection stays explicit even when it contains no usable text.
 * Whole-board fallback is appropriate only when nothing is selected. */
export function selectedSubjectBag(members: readonly SubjectMember[], selectedIds: ReadonlySet<string>, maxChars = DEFAULT_MAX_SUBJECT_CHARS): string {
  return subjectBag(selectedIds.size ? members.filter(member => selectedIds.has(member.memberId)) : members,
    plainLine, maxChars);
}
