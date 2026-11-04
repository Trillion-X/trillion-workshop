// packages/group/read-data/board-questions.ts
//
// OPEN QUESTIONS — the interrogative content of a board as first-class. On a brainstorm / research / vision
// board the questions ("What is our pricing?", "How do we onboard?") are the OPEN THREADS worth answering, but
// they are buried in card prose. This surfaces them: every card LINE that reads as a question becomes a
// pullable item, so "show me all my open questions" and "select the cards that still have questions" fall out.
// Distinct from every other reader — it is about the GRAMMAR of a line, not the graph, the layout, or the tags.
//
// A line is a question if it ends with '?' (the unambiguous signal) OR its first word is a WH-interrogative
// (who/what/when/where/why/how/which/whose/whom — these overwhelmingly BEGIN questions). Bare auxiliary
// inversions without a '?' ("do the work", "will smith", "can opener") are deliberately NOT flagged — they
// collide with imperatives, names and nouns, and a real inverted question almost always carries its '?'. The
// opener list is DATA (`QUESTION_STARTERS`), overridable per call — NOT a hardcoded branch, so a different
// language / vocabulary is a data swap, never a code change (L090/enum-dissolution). Pure, deterministic
// (board order, de-duped per card), no I/O.

import type { BoardItem } from './group-board-model';

/** The WH-interrogative sentence openers — Society DATA (overridable). A line starting with one of these reads
 *  as a question even without a '?'. Bare auxiliaries (is/do/can/…) are intentionally excluded (imperative
 *  collision); an inverted-auxiliary question is caught by its '?'. */
export const QUESTION_STARTERS: readonly string[] = [
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose', 'whom',
];

/** The first word of a line, lowercased with surrounding punctuation stripped ('' when the line has none). */
function firstWord(line: string): string {
  const m = line.trim().toLowerCase().match(/[a-z']+/);
  return m ? m[0] : '';
}

/** True iff a single line reads as a question: ends with '?' OR opens with an interrogative/auxiliary word. */
export function isQuestionLine(line: string, starters: ReadonlySet<string> = new Set(QUESTION_STARTERS)): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.endsWith('?')) return true;
  return starters.has(firstWord(t));
}

/** The DISTINCT question lines in a card's text (trimmed, first-seen order, de-duped). Empty when none. */
export function cardQuestions(item: BoardItem, starters: ReadonlySet<string> = new Set(QUESTION_STARTERS)): string[] {
  const raw = typeof item.text === 'string' ? item.text : '';
  if (raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!isQuestionLine(t, starters)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** True iff a card contains at least one question line. */
export function isQuestionCard(item: BoardItem, starters: ReadonlySet<string> = new Set(QUESTION_STARTERS)): boolean {
  return cardQuestions(item, starters).length > 0;
}

/** One card's questions. */
export interface CardQuestions {
  readonly cardId: string;
  readonly questions: readonly string[];
}

/** Every card that has ≥1 question, with its question lines — the board's open threads, in board order. */
export function boardQuestions(items: readonly BoardItem[], starters: ReadonlySet<string> = new Set(QUESTION_STARTERS)): CardQuestions[] {
  const out: CardQuestions[] = [];
  for (const it of items) {
    const qs = cardQuestions(it, starters);
    if (qs.length > 0) out.push({ cardId: it.memberId, questions: qs });
  }
  return out;
}

/** The sorted ids of cards that contain a question — the "Select open questions" set. */
export function cardsWithQuestions(items: readonly BoardItem[], starters: ReadonlySet<string> = new Set(QUESTION_STARTERS)): string[] {
  return boardQuestions(items, starters).map((c) => c.cardId).sort();
}

/** True iff the board has any open question — the gate for surfacing the select/export affordance. */
export function boardHasQuestions(items: readonly BoardItem[]): boolean {
  return boardQuestions(items).length > 0;
}

/** Render the open questions as a flat report: a "## Open questions (N)" header + one bullet per question
 *  (across all cards, in board order, total-de-duped). "No open questions" when none. */
export function questionsText(items: readonly BoardItem[], title?: string): string {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const c of boardQuestions(items)) {
    for (const q of c.questions) {
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(q);
    }
  }
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (all.length === 0) return [...head, 'No open questions'].join('\n');
  return [...head, `## Open questions (${all.length})`, ...all.map((q) => `- ${q}`)].join('\n');
}
