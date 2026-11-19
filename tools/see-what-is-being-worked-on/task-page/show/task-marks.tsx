// The marks both views draw: a work item's StepMark in its status's colour, a goal's ring of work items done, the
// open/closed chevron, and the status word. Colours come from the status rows; the only motion is a 250 ms fill.
import React from 'react';
import { StepMark } from 'trillion-workshop/tools/ui/show/step-mark/StepMark';
import { muted, type Show, type Status } from '../read-data/task-rows';
import { OpenedShows } from './task-shows';

export const MARK_CSS = `
.tl-mark{display:inline-flex;flex:none;align-items:center;justify-content:center;width:20px;height:20px}
.tl-mark .step-mark{width:20px;height:20px;box-sizing:border-box;corner-shape:round;font-size:11px;border-color:color-mix(in srgb,var(--color-foreground) 30%,transparent);transition:background-color .25s,border-color .25s,color .25s}
.tl-mark .step-mark svg{width:11px;height:11px}
.tl-mark .step-mark[data-state=checking]{animation:none;box-shadow:none;border-width:2px;border-color:var(--tl-tone)}
.tl-mark .step-mark[data-state=unknown]{border-width:2px;border-color:var(--tl-tone)}
.tl-mark .step-mark[data-state=done]{background:var(--tl-tone,var(--color-success))}
.tl-ring circle{transition:stroke-dasharray .25s,stroke .25s,fill .25s}
.tl-row{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;padding-left:0;padding-right:0;border:0;background:none;color:inherit;font-family:inherit;text-align:left;cursor:pointer}
.tl-row:focus-visible,.tl-control:focus-visible{outline:2px solid var(--color-ring);outline-offset:2px;border-radius:6px}
.tl-control{border-style:solid;border-width:1px}
[data-segmented-control]{border-style:solid}
[data-segmented-control]>button{border:0;font:inherit;cursor:pointer}
`;

/** A work item's mark: its status's StepMark in the status's colour; faint when the item was not made yet. */
export function Mark({ look, made = true }: { look: Status | undefined; made?: boolean }) {
  return (
    <span className="tl-mark" style={{ '--tl-tone': look?.tone ?? undefined, opacity: made ? 1 : 0.45 } as React.CSSProperties}>
      <StepMark state={look?.mark ?? 'todo'} />
    </span>
  );
}

/** A goal's mark: a ring that fills with the share of its work items done, tinted only when the goal is complete. */
export function Ring({ done, total, complete }: { done: number; total: number; complete: boolean }) {
  const r = 8, around = 2 * Math.PI * r, share = total ? done / total : 0;
  return (
    <svg className="tl-ring flex-none" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={r} strokeWidth="2.5" style={{ stroke: 'color-mix(in srgb, var(--color-foreground) 14%, transparent)', fill: complete ? 'color-mix(in srgb, var(--color-success) 18%, transparent)' : 'none' }} />
      <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" strokeLinecap={share > 0 && share < 1 ? 'round' : 'butt'} transform="rotate(-90 10 10)"
        style={{ stroke: 'var(--color-success)', strokeDasharray: `${share * around} ${around}` }} />
    </svg>
  );
}

export const Chevron = ({ open }: { open: boolean }) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" className="flex-none" style={{ color: muted }} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={open ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
  </svg>
);

/** A status's word in its own colour (muted when the status has none). */
export const Word = ({ look }: { look: Status | undefined }) =>
  look ? <span className="flex-none text-[13px]" style={{ color: look.tone ?? muted }}>{look.name}</span> : null;

/** An opened row: one plain paragraph saying what the work is and where it stands (the row's plain detail). The record
 *  behind it (the evidence the status rests on, and the exact task as it was written) is the same thing said again in
 *  working terms, so it waits behind one "How we know" link, in the same type, and is never stacked under the paragraph.
 *  A row with no plain detail shows its evidence as the paragraph. */
export const Detail = ({ id, detail, evidence, title, shows }: { id: string; detail?: string | null; evidence?: string | null; look?: Status; title: string; shows: Show[] }) => {
  const [record, setRecord] = React.useState(false);
  const said = detail ?? evidence ?? null;
  const behind = [detail ? evidence : null, title !== said ? title : null].filter((text): text is string => !!text);
  return (
    <>
      <div id={id} className="flex flex-col gap-2 pb-3 pl-8 pr-6">
        {said && <p className="m-0 text-[14px] leading-[1.55]" style={{ textWrap: 'pretty' }}>{said}</p>}
        {behind.length > 0 && (
          record
            ? behind.map(text => <p key={text} className="m-0 text-[14px] leading-[1.55]" style={{ textWrap: 'pretty' }}>{text}</p>)
            : <button type="button" className="self-start cursor-pointer border-0 bg-transparent p-0 text-[13px] leading-5 underline underline-offset-2" style={{ color: 'inherit', font: 'inherit', fontSize: 13 }} onClick={() => setRecord(true)}>How we know</button>
        )}
      </div>
      <OpenedShows shows={shows} />
    </>
  );
};
