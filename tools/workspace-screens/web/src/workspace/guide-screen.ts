// src/workspace/guide-screen.ts
//
// PURPOSE
//   One screen drawn by the shared guide (parts/ui/show/coss/guide.tsx) from a description built on each read, where
//   every action carries its own work: `act(action, run)` ties an action to what pressing it does. A failure is said
//   in a notification and the screen reads itself again after every action. A read or action the person's plan does
//   not include draws the shared plan state instead (failure.ts). Used by the Spaces, Community and Tours
//   screens; the guide draws into whatever element it is given (one place of a pursuit is one such element).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is invented while loading: the shared loading rows show until the first read answers, and a first read
//      that fails says so with a way to try again (a later one keeps the screen and says so in a notification), or,
//      when it is a feature the plan does not include, says what a paid plan unlocks with a way to Plan.
//   2. Coming back to the page reads it again, since what other people do changes it outside this page.
//   3. This file writes no markup: the guide and its loading, empty and failed states are the shared components
//      (parts/ui/show/screen-state); a build may answer an empty state for a place that is gone.
//   4. Only something that may have changed outside the page asks for a read: `build` is told whether this drawing
//      follows a fresh read (`fresh`), and an action that only changed what this screen shows (a place in it, an open
//      course) answers `LOCAL`, so the screen is drawn again from what it last read.

import { guideActionSource, guideReveals, mountGuide, type GuideAction, type GuideDescription, type GuideOptions } from '../../parts/ui/show/coss/guide';
import { loadScreen, type EmptyScreenState } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { PlanNeeded } from './api';
import { planState, refusal } from './failure';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// Settings a rule or workflow stands behind show its hover card and open it in the Automations editor.
import './automation-preview-source';

/** What an action answers when it changed only what this screen shows: draw again without reading. */
export const LOCAL = 'local' as const;
export type Run = (values: Record<string, string>) => Promise<void | typeof LOCAL>;
export type Act = (action: GuideAction, run: Run) => GuideAction;
/** `fresh` is true when this drawing must read again (the first drawing, after an action, coming back to the page).
 *  A build answers the guide to draw, or the empty state when there is nothing here to draw (a place that is gone). */
export type Build = (act: Act, read: { fresh: boolean }) => Promise<GuideDescription | EmptyScreenState>;

const isState = (value: GuideDescription | EmptyScreenState): value is EmptyScreenState => 'status' in value;

/** Draws a guide from a description whose actions each carry their own work; a failure is said in a notification.
 *  `options` is what the guide takes beyond the description, such as the parts a section may name (`parts`). */
export function guideScreen(element: HTMLElement, loading: string, build: Build, options: GuideOptions = {}) {
  let guide: ReturnType<typeof mountGuide> | null = null;
  let fresh = true;
  // What a press revealed stays shown when the guide is drawn anew (a kept copy replaced by the network's).
  const shown = { ...options, reveals: options.reveals ?? guideReveals() };
  const host = document.createElement('div');
  host.className = 'trillion-guide';
  element.replaceChildren(host);
  const runs = new WeakMap<GuideAction, Run>();
  const act = (action: GuideAction, run: Run) => { runs.set(action, run); return action; };

  const screen = loadScreen(host, {
    loading: { label: loading, layout: 'rows' },
    read: () => build(act, { fresh }),
    empty: value => (isState(value) ? value : null),
    failed: refusal('This could not load'),
    clear: () => { guide?.unmount(); guide = null; },
    update: value => { guide?.update(value as GuideDescription); },
    draw: value => {
      const description = value as GuideDescription;
      if (guide) { guide.update(description); return; }
      guide = mountGuide(host, description, async (action, values) => {
        let outcome: void | typeof LOCAL;
        try { outcome = await runs.get(guideActionSource(action))?.(values); } catch (error) {
          if (error instanceof PlanNeeded) screen.show(planState(error));
          else notify(errorWords(error), { kind: 'error' });
          // Keep rejection visible to the shared action button. Resolving here
          // makes its row clear typed fields as though the operation succeeded.
          throw error;
        }
        await read(outcome !== LOCAL);
      }, shown);
    },
  });
  const read = (again = true) => { fresh = again; return screen.reload(); };
  // What others put in a space changes outside this page, so coming back to the page reads it again.
  const onVisible = () => { if (document.visibilityState === 'visible') void read(); };
  document.addEventListener('visibilitychange', onVisible);
  return {
    reload: () => read(),
    /** Draw again from what was last read (a place chosen in the screen's own nav). */
    redraw: () => read(false),
    /** Scroll the drawn guide back to its top (another place chosen in the screen's own nav). */
    toTop: () => host.scrollTo({ top: 0 }),
    unmount: () => { document.removeEventListener('visibilitychange', onVisible); screen.dispose(); element.replaceChildren(); },
  };
}
