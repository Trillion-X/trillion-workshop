// tools/ui/show/notifications/notification-words.ts
//
// PURPOSE
//   What a notification shows a person, and what its Details hold. Every notification's title and detail pass through
//   the failure-words gate (safe-error-card/sanitize-error-text): a message written for a program, an engine's failure,
//   an id or a path is replaced by the kind's words (notification-kinds.json `gate_words`, else `default_gate_words`), and
//   a detail that cannot pass is left out. The raw words are kept for the row's Details, behind one press.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no React, no DOM. NotificationParts draws what this returns.
//   2. A notification is never shown raw: when the gate changes its title or detail, the raw words go to Details only.

import kindsData from './notification-kinds.json';
import {sanitizeErrorText} from '../safe-error-card/sanitize-error-text';

type GatedWords = {title: string; detail: string};
type NoticeWords = {kind?: string | null; title: string; detail?: string | null};

export const gateWordsOf = (kind: string | null | undefined, kinds: Record<string, {gate_words?: GatedWords}>): GatedWords =>
  (kind ? kinds[kind]?.gate_words : undefined) ?? (kindsData as {default_gate_words: GatedWords}).default_gate_words;

/** The title and detail a person reads, through the gate. */
export function shownWords(record: NoticeWords, kinds: Record<string, {gate_words?: GatedWords}>): {title: string; detail: string} {
  const gate = gateWordsOf(record.kind, kinds);
  return {
    title: sanitizeErrorText(record.title, gate.title),
    detail: record.detail ? sanitizeErrorText(record.detail, gate.detail) : '',
  };
}

/** The raw words behind a changed title or detail, for Details; null when the gate changed nothing. */
export function rawWordsOf(record: NoticeWords, kinds: Record<string, {gate_words?: GatedWords}>): string | null {
  const shown = shownWords(record, kinds);
  const changedTitle = shown.title !== record.title;
  const changedDetail = (record.detail ?? '') !== shown.detail;
  if (!changedTitle && !changedDetail) return null;
  return [record.title, record.detail].filter(Boolean).join('\n');
}
