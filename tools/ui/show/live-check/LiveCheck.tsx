// parts/ui/show/live-check/LiveCheck.tsx
//
// ADAPTED FROM: 21st.dev "Task Steps" by ddoemonn (component 23569, https://21st.dev/@ddoemonn/components/task-steps):
//   one row per thing being checked, its mark a turning arc while it is being watched and a tick once it happened, and
//   one sentence spoken to assistive technology as the state changes; with the status pill of Tolaria's "AI agents
//   ready" rows (a name, the line under it, and the state on the right). Rebuilt on the shared icon and this part's look
//   (screen-look/show/live-check.css).
//
// PURPOSE
//   What is being checked right now and how each check stands, so a person sees a thing finish by itself instead of
//   telling anyone they did it: "Waiting for the camera to send its first clip" turning into "Done".
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every line, its state's words and the time under it are the caller's.
//   2. States: `watching` (being checked now, only until the first answer), `done` (success mark), `not_yet` (a quiet
//      muted dot: looked, not true yet), `plain` (just the words: it cannot be checked by Trillion) and `failed` (the
//      words, and `note` saying it will look again). No state is a forever spinner: the caller moves a row off
//      `watching` as soon as it has an answer or the wait has run out.
//   3. The rows' state is announced politely when it changes (aria-live), never on every redraw.
//   4. Reduced motion stops the turning (the look's media query).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { NamedIcon } from '../icon';

export type LiveCheckRow = {
  key: string;
  /** What is checked, in the person's words. */
  label: string;
  /** The line under it: what was last seen, and when. */
  detail?: string;
  /** How it stands. */
  state: 'watching' | 'done' | 'not_yet' | 'plain' | 'failed';
  /** The state's own word, drawn as a pill on the right ("Checking", "Done"). */
  status?: string;
};
export type LiveCheckProps = { rows: LiveCheckRow[]; label: string; className?: string };

const MARK: Partial<Record<LiveCheckRow['state'], string>> = { watching: 'LoaderCircle', done: 'Check', failed: 'X' };

/** The checks, each with how it stands now. */
export function LiveCheck({ rows, label, className }: LiveCheckProps) {
  const sentence = rows.map(row => `${row.label}${row.status ? `: ${row.status}` : ''}`).join('. ');
  return (
    <section className={['live-check', className].filter(Boolean).join(' ')} aria-label={label}>
      {rows.map(row => (
        <div key={row.key} className="live-check-row" data-state={row.state}>
          {row.state === 'plain' ? null : (
            <span className="live-check-mark" aria-hidden="true">{MARK[row.state] ? <NamedIcon name={MARK[row.state]!} /> : <span className="live-check-dot" />}</span>
          )}
          <div className="live-check-words">
            <span className="live-check-label">{row.label}</span>
            {row.detail ? <span className="live-check-detail">{row.detail}</span> : null}
          </div>
          {row.status ? <span className="live-check-status">{row.status}</span> : null}
        </div>
      ))}
      <span className="live-check-said" role="status" aria-live="polite">{sentence}</span>
    </section>
  );
}
