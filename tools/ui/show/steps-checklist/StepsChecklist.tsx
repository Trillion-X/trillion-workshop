// parts/ui/show/steps-checklist/StepsChecklist.tsx
//
// ADAPTED FROM: 21st.dev "Onboarding Checklist" by ssychui (component 30552,
//   https://21st.dev/@ssychui/components/onboarding-checklist): the thin progress bar with its done / total count above
//   the steps, a round mark per step that fills and then draws its tick, and a done step that settles to muted words
//   struck through. Rebuilt on the shared Checkbox and this part's own look (screen-look/show/steps-checklist.css)
//   instead of the component's inline colours and motion library.
//
// PURPOSE
//   Steps a person does by hand, one row each, in order: what to do, and beside it whatever the caller puts there (a
//   value to copy, a saved login shown in place). Ticking a step is only the person keeping their place; whether the
//   whole thing is done is never decided here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every step, its extra and the count's words are the caller's.
//   2. A tick is kept on this device under the caller's `keptAt` (session storage), so a reload keeps the person's place;
//      without `keptAt` it lives only while the steps are shown.
//   3. Each step's mark is the shared Checkbox, named by the caller's `tick` words with the step's number.
//   4. Reduced motion draws the tick without its movement (the look's media query).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Checkbox } from '../coss/ui/checkbox';

export type ChecklistStep = {
  key: string;
  /** What to do. */
  label: React.ReactNode;
  /** Drawn beside the words (a value to copy). */
  beside?: React.ReactNode;
  /** Drawn under the words (anything larger, such as a saved login shown in place). */
  under?: React.ReactNode;
};
export type StepsChecklistWords = {
  /** The count above the steps: `{done}` and `{total}`. */
  count: string;
  /** A step's mark's name: `{n}` is its number. */
  tick: string;
};
export type StepsChecklistProps = { steps: ChecklistStep[]; words: StepsChecklistWords; keptAt?: string; className?: string };

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

function readKept(keptAt: string | undefined): string[] {
  if (!keptAt) return [];
  try { const kept = JSON.parse(sessionStorage.getItem(keptAt) ?? '[]'); return Array.isArray(kept) ? kept.filter(item => typeof item === 'string') : []; } catch { return []; }
}

/** The steps, each with its own mark, under the count of those ticked. */
export function StepsChecklist({ steps, words, keptAt, className }: StepsChecklistProps) {
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set(readKept(keptAt)));
  const toggle = (key: string, on: boolean) => setTicked(before => {
    const next = new Set(before);
    if (on) next.add(key); else next.delete(key);
    try { if (keptAt) sessionStorage.setItem(keptAt, JSON.stringify([...next])); } catch { /* storage refused: the place is kept while shown */ }
    return next;
  });
  const done = steps.filter(step => ticked.has(step.key)).length;
  return (
    <section className={['steps-checklist', className].filter(Boolean).join(' ')}>
      <span className="steps-checklist-count">{fill(words.count, { done, total: steps.length })}</span>
      <div className="steps-checklist-bar" aria-hidden="true"><span style={{ inlineSize: `${steps.length ? (done / steps.length) * 100 : 0}%` }} /></div>
      <ol className="steps-checklist-rows">
        {steps.map((step, index) => {
          const on = ticked.has(step.key);
          return (
            <li key={step.key} className="steps-checklist-row" data-control-row data-done={on ? 'true' : undefined}>
              <Checkbox className="steps-checklist-mark" checked={on} onCheckedChange={value => toggle(step.key, value === true)} aria-label={fill(words.tick, { n: index + 1 })} />
              <div className="steps-checklist-body">
                <div className="steps-checklist-line">
                  <span className="steps-checklist-words">{step.label}</span>
                  {step.beside ? <span className="steps-checklist-beside">{step.beside}</span> : null}
                </div>
                {step.under ? <div className="steps-checklist-under">{step.under}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
