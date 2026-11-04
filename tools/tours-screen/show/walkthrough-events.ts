// parts/guided-overlay/show/walkthrough-events.ts
//
// The one channel a tour starts on and the one shape tours arrive in, shared by the always-on
// WalkthroughHost and anything that lists or starts tours. No React: a screen or a test can
// use it without drawing anything.

import type { HostEvent } from '../engine/trigger-intake';
import type { WalkthroughRecord } from '../read-data/walkthrough-eeaf';
import { isShownOnScreen } from '../../ui/show/shown-on-screen/shown-on-screen';

/** The DOM CustomEvent channel any surface dispatches to trigger a tour. */
export const WALKTHROUGH_EVENT = 'bitfield:walkthrough-event';
export const WALKTHROUGH_HOST_AVAILABLE = 'bitfield:walkthrough-host-available';
export const WALKTHROUGH_DISMISS_REQUESTED = 'bitfield:walkthrough-dismiss-requested';

/** Release the matching open tour when the task it was made to point at is finished. */
export function requestWalkthroughDismissal(walkthroughId: string): void {
  if (typeof window === 'undefined' || !walkthroughId.trim()) return;
  window.dispatchEvent(new CustomEvent(WALKTHROUGH_DISMISS_REQUESTED, { detail: { walkthrough_id: walkthroughId } }));
}

/** Dispatch a host event (`{ event_kind, ...fields }`); true when a mounted host took it. */
export function emitWalkthroughEvent(detail: HostEvent): boolean {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent(WALKTHROUGH_EVENT, { detail, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Deliver an event after the host has mounted, without relying on a page-load race. */
export function emitWalkthroughEventWhenHostReady(detail: HostEvent): void {
  if (typeof window === 'undefined') return;
  const stop = () => {
    window.removeEventListener(WALKTHROUGH_HOST_AVAILABLE, send);
    window.removeEventListener(WALKTHROUGH_ENDED, send);
  };
  const send = () => { if (emitWalkthroughEvent(detail)) stop(); };
  window.addEventListener(WALKTHROUGH_HOST_AVAILABLE, send);
  window.addEventListener(WALKTHROUGH_ENDED, send);
  queueMicrotask(send);
}

/** The DOM event the host raises when a tour closes (finished, skipped or dismissed). */
export const WALKTHROUGH_ENDED = 'bitfield:walkthrough-ended';

/** Say that the tour on screen has closed, so a screen whose tour was turned away can ask again. */
export function announceWalkthroughEnded(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WALKTHROUGH_ENDED));
}

/**
 * Say `detail` when `element` has stayed on screen (it has a size and is not hidden) for
 * `settleMs`, so a tour for a screen starts when the person is looking at that screen: never
 * while its tab waits behind another, and never for a tab shown only for a moment while the
 * page restores its layout. Until a host takes it, it is said again each time the screen
 * settles on screen and each time another tour closes while the screen is shown, so a
 * screen opened while another tour was showing still gets its own tour once that one ends.
 * Returns the call that stops watching.
 */
export function emitWalkthroughEventWhenShown(element: HTMLElement, detail: HostEvent, settleMs = 800): () => void {
  if (typeof ResizeObserver !== 'function') {
    emitWalkthroughEvent(detail);
    return () => {};
  }
  const shown = () => isShownOnScreen(element);
  let settling: ReturnType<typeof setTimeout> | undefined;
  const cancelSettling = () => {
    if (settling !== undefined) clearTimeout(settling);
    settling = undefined;
  };
  const stop = () => {
    cancelSettling();
    observer.disconnect();
    window.removeEventListener(WALKTHROUGH_ENDED, onTourEnded);
  };
  const say = () => {
    if (shown() && emitWalkthroughEvent(detail)) stop();
  };
  const settle = () => {
    cancelSettling();
    if (!shown()) return;
    settling = setTimeout(() => {
      settling = undefined;
      say();
    }, settleMs);
  };
  const onTourEnded = () => settle();
  const observer = new ResizeObserver(settle);
  observer.observe(element);
  window.addEventListener(WALKTHROUGH_ENDED, onTourEnded);
  return stop;
}

/** The tours an app ships, as fold records (a bare definition, or `{ address, payload }`). */
export function toWalkthroughRecords(raw: unknown): WalkthroughRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((row) => {
      const hasWrapper = 'payload' in row && row.payload && typeof row.payload === 'object';
      return {
        address: typeof row.address === 'string' ? row.address : '',
        value_json: hasWrapper ? (row.payload as Record<string, unknown>) : row,
      };
    });
}

/** Tours a screen offers for what it shows (a pursuit carrying its own tour for its members), heard by the host. */
export const WALKTHROUGH_DEFINITIONS_OFFERED = 'bitfield:walkthrough-definitions-offered';

// What a tour written by someone else may do on this person's page: put words into a box. Anything that presses,
// chooses or sends on their behalf (a step's act other than typing, a button's perform) is left out, so a tour a
// pursuit carries can show and suggest, never act for the person.
const TYPING_ONLY = (act: unknown): boolean => !!act && typeof act === 'object' && (act as { do?: unknown }).do === 'type';
function withoutActingForThePerson(definition: Record<string, unknown>): Record<string, unknown> {
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  return {
    ...definition,
    steps: steps.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const { act, nav, content, ...step } = raw as Record<string, unknown>;
      const payload = (content as { payload?: Record<string, unknown> } | undefined)?.payload;
      const options = Array.isArray(payload?.options)
        ? payload.options.map((option: unknown) => {
            if (!option || typeof option !== 'object') return option;
            const { act: optionAct, ...rest } = option as Record<string, unknown>;
            return TYPING_ONLY(optionAct) ? { ...rest, act: optionAct } : rest;
          })
        : undefined;
      const buttons = (nav as { buttons?: unknown[] } | undefined)?.buttons;
      return {
        ...step,
        ...(TYPING_ONLY(act) ? { act } : {}),
        ...(content ? { content: options ? { ...(content as object), payload: { ...payload, options } } : content } : {}),
        ...(nav ? { nav: { ...(nav as object), ...(Array.isArray(buttons) ? { buttons: buttons.map((button) => {
          if (!button || typeof button !== 'object') return button;
          const { perform: _perform, ...rest } = button as Record<string, unknown>;
          return rest;
        }) } : {}) } } : {}),
      };
    }),
  };
}

/** Offer tours a screen carries for what it shows. The host folds them beside its own (the same fold refuses a bad
 *  one), kept only for this page, and tries them against what the page just said (a screen opening), so a tour whose
 *  trigger matches that opening starts as if it had been there all along. */
export function offerWalkthroughDefinitions(definitions: readonly unknown[]): void {
  if (typeof window === 'undefined') return;
  const offered = definitions
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object' && !Array.isArray(one) && typeof (one as { id?: unknown }).id === 'string')
    .map(withoutActingForThePerson);
  if (!offered.length) return;
  window.dispatchEvent(new CustomEvent(WALKTHROUGH_DEFINITIONS_OFFERED, { detail: { definitions: offered } }));
}
