// parts/screen-arrangement/show/arrangement-lock.tsx
//
// PURPOSE
//   The arrangement, locked: one thing open as the only pane, and nothing else of the page reachable or drawn (no
//   sidebar, no other panes, no tab bar, no layout to switch to, no notices or tours over it) until whoever locked it
//   lets go. It is the same screen arrangement (EmbeddedScreenArrangement, the screens mounted the way every pane mounts
//   them), started on the locked screens and kept nowhere, so the person's own arrangement is untouched under it and is
//   exactly as they left it when the lock ends. Any layout or host can lock it; Trillion's hold (src/workspace/
//   needs-you-hold.tsx) does while one thing needs the person.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a screen, a host or a reason; the locked screens and the words are the caller's,
//      and whatever way out a host allows is part of its own locked screen.
//   2. While locked the page's root element carries `data-arrangement-locked`, and the look
//      (screen-look/show/arrangement-lock.css) hides every other layer the shared parts draw: the arrangement itself,
//      the sidebar, notices and tours. A host hides its own extra layers the same way. The lock's own frame is a locked
//      region (ui/show/locked-region, `data-locked`): every layer that works across the page (answering selected
//      words, pointing, zooming the arrangement) asks it and does nothing there, so only the locked screen's own
//      controls act.
//   3. A screen the person asks for while locked (a press inside the locked screen, or the caller's askBesideLock for an
//      address the page was opened at) opens beside the locked screen, inside the lock, never under it; one asked
//      screen at a time, and the caller's `back` press closes it. An open nobody pressed for (a tour preparing its
//      step, a screen opening itself on load) is never admitted: only a press inside the lock frame moments before
//      counts as asking. On a narrow window the asked screen takes the single visible pane until Back; the held
//      screen stays mounted so an unfinished answer returns unchanged. The locked screen can never be closed or moved.
//      What is asked may be a whole arrangement (a layout a link named) instead of one screen.
//   6. This lock is the one owner of whether a tour may show while it is up (`tourMayShow`): none may, except a tour the
//      person asked for by name with a press inside this lock frame moments before (a Show me on the locked screen).
//      A tour asked by anything else (an AI, a notice, a link, a schedule, a tour asked before this lock arrived) never
//      draws over or beside the locked screen; a tour host asks `tourMayShow` before it starts one and waits for
//      `onLockChange` to try again. While an admitted tour runs the page's root carries `data-arrangement-lock-guided`
//      and the look draws it over the lock (every other layer stays hidden); a new lock key admits nothing again.
//   5. A lock that is `alone` admits nothing beside it at all and draws no back press: the one screen is everything
//      until the caller lets go, and whatever that screen needs is drawn inside it.
//   4. Nothing of the lock is kept: unlocking removes the frame, and the arrangement under it was never changed.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { Button, LAYER_ORDER, NamedIcon } from '../../ui';
import { PLACEABLE_SURFACE_MIME } from '../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { useNarrowViewport } from '../../ui/show/use-narrow-viewport/useNarrowViewport';
import { BROWSER_LOCAL_LAYOUT_STATE_UNAVAILABLE } from 'trillion-workshop/tools/arrange-screens-in-panes/do-work/save-layout-state.ts';
import { immersiveChrome } from '../read-data/chrome-visibility';
import { readStarterLayouts } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/starter-layouts.ts';
import { EmbeddedScreenArrangement } from './EmbeddedScreenArrangement';
import { LOCKED_ATTRIBUTE } from '../../ui/show/locked-region';

/** One screen open in the lock: its id among the screens offered, what it opens on, and its title. */
export type LockedScreen = {
  id: string;
  input?: Record<string, unknown>;
  title?: string;
  /** A whole arrangement to open instead of the one screen (a layout, as starter layouts keep it). */
  arrangement?: Record<string, unknown>;
};
export type ArrangementLock = {
  /** Names this lock; a new key starts it afresh unless its predecessor is explicitly named below. */
  key: string;
  /** The screen the lock is on. */
  screen: LockedScreen;
  /** The address label of the screens offered (the list the page's own arrangement reads). */
  listLabel: string;
  /** The words of the press that closes a screen asked for beside the locked one (unused when `alone`). */
  back?: string;
  /** Nothing opens beside the locked screen and no back press is drawn (invariant 5). */
  alone?: boolean;
  /** Carries the person's asked pane only from this predecessor lock; Back remains effective. */
  inheritAskedFrom?: string;
};

let current: ArrangementLock | null = null;
let asked: LockedScreen | null = null;
let requestedTourActive = false;
const listeners = new Set<() => void>();
let root: Root | null = null;
let host: HTMLElement | null = null;
const tell = () => {
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-arrangement-lock-guided', Boolean(current && requestedTourActive));
  for (const listener of listeners) listener();
};
// When the person last pressed a control inside the lock frame (a pointer press, or Enter or Space with no modifier):
// only an open that follows such a press is theirs. A shortcut (a modifier key) opens nothing into a lock.
let pressedInsideAt = -Infinity;
const PRESS_COUNTS_FOR_MS = 5000;
const pressedInsideJustNow = () => performance.now() - pressedInsideAt <= PRESS_COUNTS_FOR_MS;

/** Whether a tour may show now (invariant 6): always with no lock; under a lock only one the person asked for by name
 *  with a press inside the lock frame moments before. */
export function tourMayShow({ askedByName }: { askedByName: boolean }): boolean {
  return !current || (askedByName && pressedInsideJustNow());
}

/** Hears every change of the lock (locked, let go, another screen), so a tour host can try a waiting tour again. */
export function onLockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Says a tour host's run started (true) or ended (false). Only a run `tourMayShow` admitted under this lock draws over
 *  it; anything else stays undrawn until the lock lets go (invariant 6). */
export function setArrangementLockTourActive(active: boolean): void {
  requestedTourActive = active && Boolean(current) && pressedInsideJustNow();
  tell();
}
const ASKED_PANES_STACK_BELOW_PX = 760;
const EMPTY_LOCK_STATE = {};
const LOCK_CHROME = immersiveChrome();
function notePress(event: Event) {
  if (!host || !(event.target instanceof Node) || !host.contains(event.target)) return;
  if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'Enter' && event.key !== ' '))) return;
  pressedInsideAt = performance.now();
}

/** What a placeable-surface open asks for, as a screen in the lock. */
function askedOf(detail: unknown): LockedScreen | null {
  if (!detail || typeof detail !== 'object') return null;
  const row = detail as { id?: unknown; title?: unknown; surfaceInput?: unknown };
  if (typeof row.id !== 'string') return null;
  return { id: row.id, ...(row.surfaceInput && typeof row.surfaceInput === 'object' ? { input: row.surfaceInput as Record<string, unknown> } : {}), ...(typeof row.title === 'string' ? { title: row.title } : {}) };
}
const same = (one: LockedScreen, other: LockedScreen) => one.id === other.id && JSON.stringify(one.input ?? {}) === JSON.stringify(other.input ?? {})
  && JSON.stringify(one.arrangement ?? null) === JSON.stringify(other.arrangement ?? null);

// Invariant 3: while locked, an open asked of the page opens beside the locked screen.
function onAsked(event: Event) {
  if (!current || current.alone) return;
  if (!pressedInsideJustNow()) return;
  const screen = askedOf((event as CustomEvent).detail);
  if (!screen || same(screen, current.screen)) return;
  asked = screen;
  tell();
}

const ScreenInLock = React.memo(function ScreenInLock({ lock, screen, slot }: { lock: ArrangementLock; screen: LockedScreen; slot: 'held' | 'asked' }) {
  const inputKey = JSON.stringify(screen.input ?? {});
  const arrangementKey = JSON.stringify(screen.arrangement ?? null);
  const starter = React.useMemo(() => readStarterLayouts([{ id: `lock-${lock.key}-${slot}`, name: screen.title ?? screen.id,
    arrangement: screen.arrangement ?? { kind: 'pane', surfaces: [{ id: screen.id, input: screen.input ?? {}, ...(screen.title ? { title: screen.title } : {}) }] } }])[0] ?? null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- arrangementKey stands for screen.arrangement
  [lock.key, slot, screen.id, screen.title, inputKey, arrangementKey]);
  const layoutEntryInput = React.useMemo(() => ({ input: 'layout-state-by-address-label', params: { addressLabel: `arrangement-lock:${lock.key}:${slot}` } }), [lock.key, slot]);
  return (
    <EmbeddedScreenArrangement
      key={`${screen.id}${inputKey}${arrangementKey}`}
      applicationRef={`lock:${lock.key}:${slot}`}
      initialState={EMPTY_LOCK_STATE}
      starter={starter}
      layoutEntryInput={layoutEntryInput}
      placeableSurfaceListAddressLabel={lock.listLabel}
      persistence={BROWSER_LOCAL_LAYOUT_STATE_UNAVAILABLE}
      chrome={LOCK_CHROME}
    />
  );
}, (before, after) => before.lock.key === after.lock.key && before.lock.listLabel === after.lock.listLabel && before.slot === after.slot && before.screen.title === after.screen.title && same(before.screen, after.screen));

function LockFrame() {
  const lock = React.useSyncExternalStore(subscribe, () => current);
  const beside = React.useSyncExternalStore(subscribe, () => asked);
  const narrow = useNarrowViewport(ASKED_PANES_STACK_BELOW_PX);
  if (!lock) return null;
  // A phone cannot show the two screens side by side. A direct link must show the screen it named, with Back to the
  // held thing; stacking the held thing first put the linked screen below the viewport while its URL stayed visible.
  const visible = narrow && beside ? beside : lock.screen;
  return (
    <div className="arrangement-lock" style={{ zIndex: LAYER_ORDER.lockedArrangement }} role="main" aria-label={visible.title ?? visible.id} data-arrangement-lock={lock.key} {...{ [LOCKED_ATTRIBUTE]: '' }}>
      <div className="arrangement-lock-screens">
        <div className="arrangement-lock-pane" hidden={Boolean(narrow && beside)} inert={Boolean(narrow && beside)} aria-hidden={narrow && beside ? true : undefined}>
          <ScreenInLock key={`${lock.key}:held`} lock={lock} screen={lock.screen} slot="held" />
        </div>
        {/* Back closes the asked screen, so it belongs to that pane: never a bar over the whole page, stacked above the
            held screen's own header (2026-10-11: "← Back" sat over the queue's "← 1 of 4 Next"). On a phone the asked
            pane is the one shown, so its Back is still at the top of what the person sees. */}
        {beside ? (
          <div className="arrangement-lock-pane">
            {!lock.alone ? (
              <div className="arrangement-lock-back">
                <Button variant="ghost" size="sm" onClick={returnToLockedScreen}><NamedIcon name="ArrowLeft" />{lock.back}</Button>
              </div>
            ) : null}
            <ScreenInLock key={`${lock.key}:asked`} lock={lock} screen={beside} slot="asked" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const sameLock = (one: ArrangementLock, other: ArrangementLock) => one.key === other.key && one.listLabel === other.listLabel
  && one.back === other.back && Boolean(one.alone) === Boolean(other.alone) && one.inheritAskedFrom === other.inheritAskedFrom
  && one.screen.title === other.screen.title && same(one.screen, other.screen);

/** Locks the arrangement on one screen, changes the lock, or (null) lets go (invariants 2 to 4). */
export function lockArrangement(lock: ArrangementLock | null): void {
  // The same lock again changes nothing and tells nobody: a caller re-locking on every read (each read a new object)
  // re-rendered every listener each time, and the page grew until it froze (2026-10-12).
  if (lock ? Boolean(current) && sameLock(current as ArrangementLock, lock) : !current) return;
  const inheritsAsked = Boolean(current && lock?.inheritAskedFrom === current.key);
  // A new lock (another key, or none) admits no tour it did not see asked for inside its own frame (invariant 6).
  if (current?.key !== lock?.key) requestedTourActive = false;
  if (lock && ((current?.key !== lock.key && !inheritsAsked) || lock.alone || (asked && same(asked, lock.screen)))) asked = null;
  if (!lock) asked = null;
  current = lock;
  document.documentElement.toggleAttribute('data-arrangement-locked', Boolean(lock));
  if (lock && !host) {
    host = document.createElement('div');
    host.className = 'arrangement-lock-host';
    document.body.append(host);
    root = createRoot(host);
    root.render(<LockFrame />);
    window.addEventListener(PLACEABLE_SURFACE_MIME, onAsked);
    window.addEventListener('pointerdown', notePress, true);
    window.addEventListener('keydown', notePress, true);
  }
  if (!lock && host) {
    window.removeEventListener(PLACEABLE_SURFACE_MIME, onAsked);
    window.removeEventListener('pointerdown', notePress, true);
    window.removeEventListener('keydown', notePress, true);
    pressedInsideAt = -Infinity;
    root?.unmount();
    host.remove();
    root = null;
    host = null;
  }
  tell();
}

/** Opens a screen beside the locked one, as a link or notice asking for it would (invariant 3). */
export function askBesideLock(screen: LockedScreen): void {
  if (!current || current.alone || same(screen, current.screen)) return;
  asked = screen;
  tell();
}

/** Closes the screen the person asked to see beside the held one, returning to the locked screen. */
export function returnToLockedScreen(): boolean {
  if (!current || !asked) return false;
  asked = null;
  tell();
  return true;
}
