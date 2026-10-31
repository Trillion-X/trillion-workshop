// packages/ask-questions-sort-answers-follow-up/read-data/synthesis-answer-lines.ts
//
// PURE fold: turn a sequence's latest answer-facts into the prose lines fed to
// the AI synthesis. Each line carries the QUESTION LABEL when it's known
// (`Label: answer`), so a prompt that must reason per-question — e.g. "which of
// these lenses is weakest?" — can map each answer back to what it answered.
// Fully generic: no sequence/exercise vocabulary is baked in; when a label is
// unknown the bare answer is used. The view does the I/O and passes rows here.

import { foldAnswerFacts, type AnswerFactRow } from './fold-answer-facts.ts';

const SEQUENCE_KIND = 'question-sequence';

/** questionId -> human label for a sequence, read from published
 *  `question-sequence` DATA. Pure. */
export function labelMapForSequence(published: unknown, sequenceId?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!sequenceId) return map;
  const rows = Array.isArray(published) ? published : [];
  for (const row of rows) {
    const p = row && typeof row === 'object' ? ((row as { payload?: unknown }).payload ?? row) : null;
    if (!p || typeof p !== 'object') continue;
    const rec = p as { kind?: unknown; formId?: unknown; questions?: unknown };
    if (rec.kind !== SEQUENCE_KIND || rec.formId !== sequenceId) continue;
    const qs = Array.isArray(rec.questions) ? rec.questions : [];
    for (const q of qs) {
      const qq = q as { questionId?: unknown; label?: unknown };
      if (typeof qq.questionId === 'string' && typeof qq.label === 'string') {
        map.set(qq.questionId, qq.label);
      }
    }
  }
  return map;
}

/** The person's latest answers as prose lines, each labelled with its question
 *  when the label is known. Latest session wins (most recent answeredAt). Pure. */
export function answerLinesForSequence(published: unknown, sequenceId?: string): string[] {
  const rows = (Array.isArray(published) ? published : []) as AnswerFactRow[];
  const sessions = foldAnswerFacts(rows, sequenceId ? { formId: sequenceId } : {});
  if (sessions.length === 0) return [];
  const latest = [...sessions].sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? ''))[0];
  const labels = labelMapForSequence(published, sequenceId);
  const lines: string[] = [];
  for (const [questionId, value] of Object.entries(latest.answers)) {
    const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    const trimmed = text.trim();
    if (!trimmed) continue;
    const label = labels.get(questionId);
    lines.push(label ? `${label}: ${trimmed}` : trimmed);
  }
  return lines;
}
