// parts/record-audio/read-data/processing-steps.ts
//
// PURPOSE
//   The stages a kept recording goes through before it is a finished meeting note (Upload, Transcript, Summary), and
//   where each stands. The stages are DATA (recording-widgets.json `steps.rows`, each naming the fact that decides it);
//   the facts are what the screen already holds: the file is kept, the words are kept or being made, a summary is saved.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A stage is `done` only when its fact says so. A fact nobody reported is `waiting`, never `done`.
//   2. The pill is shown only while something is being worked on (`processingNow`); a recording nobody asked to be
//      transcribed or summarised never shows a stage that will not move.
//   3. Nothing here reads the network: it turns facts into stages.

import widgets from './recording-widgets.json';

export type StepState = 'done' | 'working' | 'waiting';
export type Step = { id: string; label: string; state: StepState };
export type StepFacts = Readonly<Record<string, StepState | undefined>>;
type Row = { id: string; label: string; fact: string };

/** Each stage in order with the state its fact reports. */
export function processingSteps(facts: StepFacts, rows: readonly Row[] = widgets.steps.rows): Step[] {
  return rows.map(row => ({ id: row.id, label: row.label, state: facts[row.fact] ?? 'waiting' }));
}

/** Whether any stage is being worked on now: the one case the pill is shown. */
export const processingNow = (steps: readonly Step[]) => steps.some(step => step.state === 'working');

/** Where the words stand: kept (`ready`), being made by themselves (`making`), or neither. */
export type WordsState = 'ready' | 'making' | 'failed' | 'none';

/**
 * The facts of one kept recording: its file is kept (it was opened by its identity); its words by `words`; its summary
 * saved when `summarySaved`, or being written while `reviewing` (the person's AI is on it).
 */
export function recordingFacts({ words, summarySaved, reviewing }: { words: WordsState; summarySaved: boolean; reviewing: boolean }): StepFacts {
  return {
    file: 'done',
    transcript: words === 'ready' ? 'done' : words === 'making' ? 'working' : 'waiting',
    summary: summarySaved ? 'done' : reviewing ? 'working' : 'waiting',
  };
}
