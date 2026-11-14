// src/workspace/needs-you-hold.tsx
//
// PURPOSE
//   The hold (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs): while something truly needs the person, every Trillion page they open (this page
//   on the web, in the Mac app, in the Mac menu bar panel and in the iPhone app, which all mount it) is that ONE thing.
//   The owner 2026-10-06: "160 is not overwhelming to me, it's more that I am just not gonna do it because I don't HAVE to
//   do it... Set up everything such that there is only one thing you can do." 2026-10-07: "why not have just put this
//   in a screen in the screen arrangement, lock the ability out... if it was supposed to lock out all the stuff then
//   the sidebar wouldn't have been left visible". So the hold is the screen arrangement itself, LOCKED
//   (parts/screen-arrangement/show/arrangement-lock.tsx) on the held thing's own screen: no sidebar, no other pane, no
//   layout to switch to, no notice or tour over it. The held screen is always the thing itself on the waiting screen
//   (`/waiting/<key>`, src/workspace/waiting-screen.tsx): its words, its steps as a checklist, the place in Trillion it
//   is done in drawn in place (its card's `does_in`, such as the Facebook Page's Connect on Connections), a saved login
//   in place, what Trillion is checking ticking by itself, the next and previous held things in rank order, and as the
//   card's own last part the only ways out (src/workspace/hold-ways-out.tsx), each a counter of src/escape-chain.json:
//   set it aside for a while with a reason the AIs weigh (a few times a day), or ask the hold off, which costs what the
//   person chose in advance and never takes effect at once. One composed screen, nothing pinned over or under it.
//   Before that ordinary hold, src/setup-steps.json may lock a new account on Get started until every required owner
//   proves its step. That gate reads the existing Get started screen, fails closed on an unreadable answer, and releases
//   by itself on the first complete read; it creates no second setup state. A requested workspace address waits under
//   the setup guide while setup remains incomplete and is the page shown once it lets go; each setup step's own screen
//   is still drawn in place under that step.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of waiting thing, a stake, a screen or a word: ordinary holds are the answer's DATA,
//      words are src/waiting-on-you.json `presentation.words.hold`, stakes its `hold`; the required setup lock is DATA in
//      src/setup-steps.json and its completion is the Get started screen's checked progress.
//   2. While a thing is held the page under the lock is inert (no focus, no pointer, no keys reach it) and hidden, and
//      the hold is read again every `every_seconds`, when the page is shown again, and after every finish, so it lets
//      go the moment nothing is held.
//   3. A view-as page (someone looking at this Trillion by its owner's leave) is never held: the hold is the owner's.
//   4. Nothing opens beside the setup gate or a held thing by itself, at any width: the address the page was opened at
//      and a take-me-there link's layout (?layout=&tour=, opened by main.tsx under the lock)
//      wait under the lock and are the page shown the moment it lets go (2026-10-12: a second pane beside the setup
//      guide and beside the held card split the one thing in two). Only a press inside the held screen itself opens a
//      screen beside it, with Back to close it.
//   5. Only shared parts draw it: the arrangement lock (on the shared layer order's `lockedArrangement` layer, above
//      the page's floating sidebar and its edge strips) and the screens it mounts.
//   6. The held thing shown on a visible page is a receipt: the page tells the store once per held thing (op seen, with
//      this browser's device id), so the notices that reached the person about it are read here, their ordered reach to
//      the person's other ways stops, and Trillion keeps where they saw it (src/tell-the-person.mjs invariant 17).
//

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { lockArrangement, type LockedScreen } from '../../parts/screen-arrangement/show/arrangement-lock';
import { addressOpensOneOfSurfaces, placeOfAddress, watchWorkspaceAddress } from './addresses.mjs';
import { HOLD_API, primeHold, readCurrentPersonalHold, useHold, type HoldView } from './hold-ways-out';
import surfaces from './screens.mjs';
import type { ScreenRow } from './offered-screens';
import waitingOnYou from '../waiting-on-you.json';
import setup from '../setup-steps.json';
import { setupScreenComplete } from 'trillion-workshop/tools/hold-one-thing-until-done/read-data/required-cover.mjs';
import { postNothingRead, readJson } from './api';
import { onStoreHeadChange } from './store-changes';
import { coverOf as coverFrom, watchRequiredSetup } from './required-setup-reader.mjs';
import { thisDeviceId } from 'trillion-workshop/tools/keep-copies-in-step/web/src/workspace/catch-up.tsx';
import { heldGetStarted } from './get-started-hold.mjs';
import { readInitialPersonalHold as readInitial } from './initial-personal-hold.mjs';
import firstAnswers from './first-answers.json';

export type InitialPersonalHold = { setup: unknown; hold: HoldView };
export function readInitialPersonalHold(): Promise<InitialPersonalHold> {
  return readInitial(() => readJson(firstAnswers.paths.initial_setup), readCurrentPersonalHold);
}

const words = waitingOnYou.presentation.words;
const said = words.hold;

// The required-setup cover the page locks on (required-setup-reader.mjs coverOf): src/setup-steps.json `gate`, read so
// that a build whose DATA lost any part of the gate still covers.
const coverOf = (offered: ScreenRow[]) => coverFrom(setup, offered, firstAnswers.paths.initial_setup, waitingOnYou.hold.every_seconds);

/** Reads the signed-in Get started projection: true when setup is complete, false when it is not, null before the first
 *  answer. An unknown answer keeps the setup gate closed; an already-checked complete initial answer opens immediately. A failed first read fails
 *  closed; a later failed read keeps the last answer. It reads again when the page becomes visible or the store changes,
 *  so recovery needs no reload. */
function useRequiredSetup(initial?: unknown): boolean | null {
  const [complete, setComplete] = React.useState<boolean | null>(() => initial === undefined ? null : setupScreenComplete(initial));
  React.useEffect(() => {
    let kept: unknown = initial ?? null;
    const read = async (active: () => boolean) => {
      if (!active()) return null;
      // The same read the Get started screen makes (guide-screens.tsx): the page's own answer, the kept copy, one shared
      // in-flight request and the busy retry. A refusal or an unreadable answer throws, so the gate stays closed.
      const description = heldGetStarted(kept, await readJson<unknown>('/work/api/screens/get-started'));
      kept = description;
      const answered = setupScreenComplete(description);
      if (active()) setComplete(answered);
      return answered;
    };
    return watchRequiredSetup({ initialComplete: initial !== undefined && setupScreenComplete(initial),
      intervalMs: coverOf([]).everySeconds * 1000, read, onFailure: () => setComplete(now => now ?? false),
      listen: changed => onStoreHeadChange(changed, 'setup'), page: document });
  }, []);
  return complete;
}

/** The screen an address of this page opens, with everything it opens on (addresses.mjs `placeOfAddress`); null when
 *  the address is not one of this page's screens. */
export function screenOfAddress(offered: ScreenRow[], address: string): LockedScreen | null {
  const place = placeOfAddress(offered, address, location.origin) as { row: ScreenRow; input: Record<string, unknown> } | null;
  if (!place) return null;
  return { id: place.row.id, input: place.input, ...(typeof place.row.label === 'string' ? { title: place.row.label } : {}) };
}

/** The screen the held thing is shown on: the thing itself on the waiting screen, where its control is drawn in place. */
export function heldScreen(held: NonNullable<HoldView['held']>): LockedScreen {
  return { id: words.needs_you.queue_screen, input: { thing: held.key }, title: held.card.title ?? held.section.title };
}

function Hold({ beneath, offered, initial, onReady }: { beneath: HTMLElement; offered: ScreenRow[]; initial?: InitialPersonalHold; onReady: () => void }) {
  const { view } = useHold();
  const [address, setAddress] = React.useState(() => location.href);
  React.useEffect(() => watchWorkspaceAddress(() => setAddress(location.href)), []);
  // Only a checked complete answer releases the gate. Before the first answer and while setup is incomplete, no
  // offered surface is admitted directly; the full-window Get started screen remains the only page until the
  // current-state check completes. Each destination still keeps its own account and rule owners.
  const setupComplete = useRequiredSetup(initial?.setup) === true;
  const cover = coverOf(offered);
  const setupSurfaceAdmitted = !setupComplete && addressOpensOneOfSurfaces(
    offered, address, location.origin, cover.admit,
  );
  const setupGateReleased = setupComplete || setupSurfaceAdmitted;
  const held = setupGateReleased ? view?.held ?? null : null;
  const screen: LockedScreen | null = setupGateReleased
    ? (held ? heldScreen(held) : null)
    : (cover.screen ? { id: cover.screen, input: {}, title: setup.words.title } : null);
  const lockKey = setupGateReleased ? held?.key ?? null : cover.key;
  const screenKey = screen ? JSON.stringify(screen) : '';
  // The arrangement locked on the held thing's screen, the page under it inert (invariant 2); it changes only when the
  // held screen does, so a read that holds the same thing again (a new object) leaves it as it is. The address the page
  // was opened at and a linked layout stay under the lock and show once it lets go (invariant 4).
  React.useEffect(() => {
    if (!screen || !lockKey) { lockArrangement(null); beneath.inert = false; onReady(); return undefined; }
    beneath.inert = true;
    lockArrangement({ key: lockKey, screen, listLabel: surfaces.address_label, back: said.back,
      ...(setupComplete ? { inheritAskedFrom: cover.key } : {}) });
    onReady();
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- screenKey stands for screen
  }, [lockKey, screenKey, setupComplete, beneath]);
  React.useEffect(() => () => { lockArrangement(null); beneath.inert = false; }, [beneath]);
  // The held thing seen on this page, once per thing while the page is visible (invariant 6).
  const seenKey = React.useRef<string | null>(null);
  const heldKey = held?.key ?? null;
  React.useEffect(() => {
    if (!heldKey) return undefined;
    const seen = () => {
      if (document.visibilityState !== 'visible' || seenKey.current === heldKey) return;
      seenKey.current = heldKey;
      // A receipt, sent at most once per held thing: it changes no read this page shows, so every read stays local.
      void postNothingRead(HOLD_API, { op: 'seen', key: heldKey, device_id: thisDeviceId }).catch(() => { seenKey.current = null; });
    };
    seen();
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, [heldKey]);
  return null;
}

/** Mounts the hold over `beneath` (the page's own root), for a page that is not someone else looking (invariant 3). */
export function mountNeedsYouHold(beneath: HTMLElement, offered: ScreenRow[], initial?: InitialPersonalHold): (() => void) & { ready: Promise<void> } {
  const host = document.createElement('div');
  host.className = 'hold-host';
  document.body.append(host);
  const root = createRoot(host);
  if (initial) primeHold(initial.hold);
  let onReady!: () => void;
  const ready = new Promise<void>(resolve => { onReady = resolve; });
  root.render(<Hold beneath={beneath} offered={offered} initial={initial} onReady={onReady} />);
  return Object.assign(() => { root.unmount(); host.remove(); }, { ready });
}
