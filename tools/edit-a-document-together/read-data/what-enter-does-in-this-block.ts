import type { WhatEnterDoesData, WhatEnterDoesOutcome } from './documents.ts';

// packages/documents/read-data/what-enter-does-in-this-block.ts
//
// PURPOSE
// Decide what pressing Enter does inside a block, WITHOUT the decider ever learning that bullets,
// todos, numbered lists, quotes or callouts exist. Every one of those is an input-shortcut DATA row
// (documents.input-shortcuts). A row that wants Enter to continue it says so in its own data; this
// module reads that answer and returns it. Adding a new continuable kind is one DATA field and zero
// lines here, which is the whole point (L063/L090, enum dissolution).
//
// WHY THIS EXISTS
// Pressing Enter at the end of a bullet produced a plain block instead of the next bullet. The cause
// was not a missing branch, it was a missing QUESTION: the Enter handler bound the action 'new-block'
// unconditionally and never asked what kind of block it was leaving. A block also had no way to say
// which rule made it, so no handler could have asked. Both halves are fixed as data: a rule stamps
// `made_by_shortcut` on the block it produces, and declares `what_enter_does`.
//
// NON-NEGOTIABLE INVARIANTS
// 1. No kind name appears in this file. No 'bullet', no 'todo', no 'ordered'. Grep proves it.
// 2. A rule that declares nothing behaves exactly as before (a plain new block), so this is additive
//    and cannot regress an existing document or an existing rule.
// 3. Pure. No DOM, no React, no engine. Same facts in, same decision out, always.
// 4. The decision is DESCRIBED, never performed here. The caller performs it, blind to the reason.

/** What a rule says Enter should do in a block that rule produced. Both fields are DATA-supplied. */
/** The shape this module needs from an input-shortcut DATA row. Everything else is ignored. */
export interface ContinuableShortcutRule {
  id: string;
  what_enter_does?: WhatEnterDoesData;
  material_template?: { id: string; content_role?: string; state?: string };
  /** Present on numeric gesture rules; a continued item re-emits the NEXT ordinal, not the same one. */
  match?: { numeric?: boolean } & Record<string, unknown>;
  effect_template?: unknown[];
}

/** The facts that fully determine the decision. No event object, no node tree. */
export interface EnterFacts {
  /** The block's `made_by_shortcut` prop, if a rule stamped it. Absent for ordinary paragraphs. */
  madeByShortcut?: string | null;
  /** The block's full current text, marker included. */
  text: string;
  /** Every input-shortcut rule currently loaded, in DATA order. */
  rules: ContinuableShortcutRule[];
  /** A structural owner paints the marker outside this editable's authored text. */
  markerIsSeparate?: boolean;
}

/**
 * The two answers a DATA row may give, plus the answer for every block that says nothing.
 * These are not an open set of app commands: they are the terminal outcomes of one keystroke in one
 * block, so a closed union is correct here (the extensible part is WHICH rows opt in, and that lives
 * in data).
 */
export type EnterDecision =
  /** Produce a fresh block and re-run the naming rule's effect on it, so the new one looks like this one. */
  | { does: 'make_another_one_like_this'; rule: ContinuableShortcutRule; nextMarker?: string }
  /** Strip this block back to a plain one. This is how a list ends: Enter on an empty item leaves it. */
  | { does: 'leave_this_kind'; rule: ContinuableShortcutRule }
  /** Today's behaviour, and the answer for anything that did not opt in. */
  | { does: 'make_a_plain_block' };

/** A leading ordinal marker, e.g. `1.` or `42)`. Fixed and bounded, so no DATA-supplied regex, no ReDoS. */
const LEADING_ORDINAL = /^(\d+)([.)])/;

/**
 * Structural markers live outside the authored text. Legacy inline markers are read from the
 * producing rule's text template; punctuation and emoji are never guessed to be a marker.
 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read only the prefix the rule actually places before captured text. Unknown templates have no inferred marker. */
export function embeddedTextMarker(text: string, rule?: ContinuableShortcutRule): string {
  for (const effect of rule?.effect_template ?? []) {
    if (!record(effect) || effect.type !== 'UPDATE_PROPS' || !record(effect.node_id)
      || !record(effect.node_id.select) || effect.node_id.select.from !== 'block' || effect.node_id.select.path !== 'id'
      || !record(effect.changes) || !record(effect.changes.props)) continue;
    const template = effect.changes.props.text;
    if (!record(template) || template.$kind !== 'template' || !Array.isArray(template.parts)) continue;
    let prefix = '';
    for (const part of template.parts) {
      if (typeof part === 'string') { prefix += part; continue; }
      if (!record(part) || part.$kind !== 'binding' || !record(part.select)
        || part.select.from !== 'captured') break;
      if (part.select.path === 'text') return prefix;
      if (part.select.path === 'match' && rule?.match?.numeric) {
        const ordinal = LEADING_ORDINAL.exec(text)?.[0];
        if (!ordinal) break;
        prefix += ordinal;
      } else break;
    }
  }
  return '';
}

export function blockIsAnEmptyOne(text: string, rule?: ContinuableShortcutRule, markerIsSeparate = false): boolean {
  if (text.trim() === '') return true;
  if (markerIsSeparate) return text.trim() === '';
  const marker = embeddedTextMarker(text, rule);
  if (!marker) return text.trim() === '';
  if (text.startsWith(marker)) return text.slice(marker.length).trim() === '';
  // Removing just the marker's trailing spaces still leaves an empty legacy item.
  return text.trim() === marker.trim();
}

/** The ordinal a continued numeric item should carry: the one it follows, plus one, same separator. */
export function nextOrdinalMarker(text: string): string | undefined {
  const found = LEADING_ORDINAL.exec(text);
  if (!found) return undefined;
  const number = Number.parseInt(found[1], 10);
  if (!Number.isFinite(number)) return undefined;
  return `${number + 1}${found[2]}`;
}

/**
 * The marker a continued item should start with, taken from the one it follows. For a counted item
 * the number advances; every other prefix comes from the producing DATA template. A structural
 * marker is painted by its owner and contributes no editable text to the new block.
 */
export function markerToStartTheNextOneWith(text: string, nextMarker?: string, rule?: ContinuableShortcutRule, markerIsSeparate = false): string {
  if (markerIsSeparate) return '';
  const marker = embeddedTextMarker(text, rule);
  return nextMarker && rule?.match?.numeric ? marker.replace(LEADING_ORDINAL, nextMarker) : marker;
}

/**
 * Decide what Enter does. Total: every input produces exactly one decision, and anything that did not
 * opt in gets the behaviour it had before this module existed.
 */
export function whatEnterDoesInThisBlock(facts: EnterFacts): EnterDecision {
  const { madeByShortcut, text, rules } = facts;
  if (!madeByShortcut) return { does: 'make_a_plain_block' };
  const rule = rules.find((candidate) => candidate.id === madeByShortcut);
  if (!rule || !rule.what_enter_does) return { does: 'make_a_plain_block' };

  const answer: WhatEnterDoesOutcome | undefined = blockIsAnEmptyOne(text, rule, facts.markerIsSeparate)
    ? rule.what_enter_does.in_an_empty_one
    : rule.what_enter_does.in_a_filled_one;

  if (answer === 'make_another_one_like_this') {
    const continuation = rule.what_enter_does.continue_as
      ? rules.find(candidate => candidate.id === rule.what_enter_does?.continue_as) ?? rule
      : rule;
    return continuation.match?.numeric
      ? { does: 'make_another_one_like_this', rule: continuation, nextMarker: nextOrdinalMarker(text) }
      : { does: 'make_another_one_like_this', rule: continuation };
  }
  if (answer === 'leave_this_kind') return { does: 'leave_this_kind', rule };
  return { does: 'make_a_plain_block' };
}
