// parts/ui/show/catch-up/CatchUpMark.tsx
//
// PROVENANCE
//   The pill: 21st.dev diceui "Status" (component 25395, MIT: a rounded pill in the state's tint with a breathing dot and
//   a short label), adapted to the look's tokens and drawn by screen-look/show/catch-up.css. The ring that fills while
//   catching up and the rule that a quiet state draws nothing come from 21st.dev "Data Refresh State" (29369, anatomy
//   only, no code taken) and the visual-hierarchy sheets.
//
// PURPOSE
//   The one small mark that says whether everything is in step, for any place that has room for one: the sidebar, a
//   pane's bar, a host app's menu bar panel, the phone. It reads the page's catch-up sources (catch-up.ts) and draws the
//   leading state: a tinted dot that breathes while work goes on, a ring that fills when how far is measured, the
//   state's words. Pressed, it opens the whole picture (CatchUpPanel) beside it. When the leading state is quiet (all
//   caught up) it draws nothing, unless `always` asks for its quiet form.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: every word, tone and icon is the caller's DATA (CatchUpWords); nothing here names a state.
//   2. A change of the leading state is announced once to a screen reader; counts moving are not announced.
//   3. The ring is drawn only from a measured percent; work whose extent is unknown breathes instead.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { lazyPart } from '../load-later/later';
import * as React from 'react';
import { cn } from '../cn';
import { NamedIcon } from '../icon';
import { Popover, PopoverPopup, PopoverTrigger } from '../coss/ui/popover';
// The whole picture is fetched the first time the mark is pressed.
const CatchUpPanel = lazyPart(() => import('./CatchUpPanel'), module => module.CatchUpPanel);
import { useCatchUp, useCatchUpWords, type CatchUpWords } from './catch-up';

const RING = 2 * Math.PI * 7;

/** The tinted dot, or the ring filling to a measured percent (invariant 3). */
export function CatchUpDot({ tone, moving, percent }: { tone?: string; moving?: boolean; percent?: number | null }) {
  if (typeof percent === 'number') {
    return (
      <svg data-catch-up-ring="" data-tone={tone} viewBox="0 0 18 18" aria-hidden className="size-4 shrink-0 -rotate-90">
        <circle data-catch-up-ring-track="" cx="9" cy="9" r="7" />
        <circle data-catch-up-ring-value="" cx="9" cy="9" r="7" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.max(0, Math.min(100, percent)) / 100)} />
      </svg>
    );
  }
  return <span data-catch-up-dot="" data-tone={tone} data-moving={moving || undefined} aria-hidden />;
}

export type CatchUpMarkProps = {
  /** The DATA to draw with; left out, the page's installed words (provideCatchUpWords), and nothing without them. */
  readonly words?: CatchUpWords;
  /** `pill`: the dot and the words; `icon`: the state's icon with its dot, for a narrow bar. */
  readonly form?: 'pill' | 'icon';
  /** Draw the quiet form when everything is in step, instead of nothing. */
  readonly always?: boolean;
  readonly className?: string;
};

export function CatchUpMark({ words: given, ...props }: CatchUpMarkProps) {
  const installed = useCatchUpWords();
  const words = given ?? installed;
  return words ? <Mark words={words} {...props} /> : null;
}

function Mark({ words, form = 'pill', always = false, className }: CatchUpMarkProps & { words: CatchUpWords }) {
  const view = useCatchUp(words);
  const [open, setOpen] = React.useState(false);
  const [said, setSaid] = React.useState('');
  React.useEffect(() => { setSaid(view.label); }, [view.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const quiet = !view.state || Boolean(view.row.quiet);
  if (quiet && !always && !open) return null;
  const label = view.label || words.words.all_in_step || '';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-catch-up-mark={form}
            data-tone={view.row.tone}
            data-quiet={quiet || undefined}
            aria-label={label}
            title={label}
            className={cn('catch-up-mark', className)}
          />
        }
      >
        {form === 'icon' ? (
          <span data-catch-up-mark-icon="" aria-hidden>
            <NamedIcon name={view.row.icon} fallback="Cloud" size="md" />
            <CatchUpDot tone={view.row.tone} moving={view.row.moving} percent={null} />
          </span>
        ) : (
          <>
            <CatchUpDot tone={view.row.tone} moving={view.row.moving} percent={view.percent} />
            <span data-catch-up-mark-words="">{label}</span>
          </>
        )}
      </PopoverTrigger>
      <span role="status" aria-live="polite" className="sr-only">{said}</span>
      <PopoverPopup className="catch-up-popup w-[min(26rem,calc(100vw-1.5rem))] p-0" side="bottom" align="end" portalProps={{ className: 'coss-ui' }}>
        <React.Suspense fallback={null}><CatchUpPanel words={words} /></React.Suspense>
      </PopoverPopup>
    </Popover>
  );
}
