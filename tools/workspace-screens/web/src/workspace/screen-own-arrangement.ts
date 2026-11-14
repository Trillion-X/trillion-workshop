// src/workspace/screen-own-arrangement.ts
//
// PURPOSE
//   Every screen can be arranged: a screen in a pane opens inside its own arrangement, the same arrangement the window
//   is (parts/screen-arrangement mountNestedScreenArrangement: panes, splits, tabs, sizes, freeform, overlay, kept
//   layouts), with the screen itself as its first pane. The person or their AI places any other screen beside it,
//   under it or over it, sizes each by dragging, and each piece can be arranged in turn, at any depth. A screen nobody
//   arranged mounts exactly as it always did: nothing extra is drawn or read.
//
//   "Arrange this screen" on the pane's ⋯ (menu-rows.tsx `page` source) shows the arrangement's own chrome (tab bars,
//   each pane's ⋯, the edges to drag); "Done arranging" hides it again so the pieces read as one screen. "Put this
//   screen back" forgets the arrangement. The arrangement is kept per person at `screen-arrangement-of::<screen>`
//   (records.ts, every device), so an AI writing that record (save_layout with `screen`) rearranges the screen live.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One arrangement at every depth: nothing here positions anything; the nested arrangement is the window's own.
//   2. A screen inside its own arrangement is itself, mounted bare (the arranged element names its screen), so the
//      first pane never opens another arrangement of the same screen.
//   3. Unarranged and not being arranged: the screen mounts as it did, with no arrangement code loaded.
//   4. A screen row can BE an arrangement of other screens (`surface_input.arrangement`, the short shape
//      parts/screen-arrangement/read-data/starter-layouts.ts reads): Home is one. It opens on that arrangement, never
//      bare, and the person's own arrangement of it is kept the same way; a new screen made of screens is one row.
//   5. Words are DATA (screen-own-arrangement.json); which chrome shows while arranging and while not is DATA too.
//   6. A screen row's `surface_input.leads` (screen ids) are drawn above its arrangement, outside it, so no arrangement
//      the person or an AI makes can drop them (Home leads with what only the person can do). Each lead mounts through
//      the page's runner (`provideLeadMount`), and a lead with nothing to show takes no room.

import { mountNestedScreenArrangement as mountNested } from '../../parts/screen-arrangement/show/mount-screen-arrangement';
import { ENGINE_OPERATION_TARGET, ENGINE_WRITE_BATCH_OPERATION_LABEL, readRecordAt, sendRequestToBitfieldTarget, subscribeRecordChanges } from './records';
import { providePageRows, announcePageRows, type Thing } from './menu-rows';
import { offeredScreens } from './open-screen';
import type { Unmount } from './lazy-screen';
import data from './screen-own-arrangement.json';
import surfaces from './surfaces.json';

const keptAt = (screen: string) => `${data.kept_prefix}${screen}`;
const ARRANGED = 'data-arranged-screen';

// Which screens are being arranged now on this page (shown with their chrome), and who redraws when that changes.
const arranging = new Set<string>();
const redraws = new Map<string, Set<() => void>>();
const redraw = (screen: string) => { for (const again of redraws.get(screen) ?? []) again(); announcePageRows(); };
/** Where a screen opened on `input` keeps its arrangement: under its own name, or one placed with its own under its
 *  `kept_as` place (a tab of the menu bar panel), so each such place is its own. */
const keptOf = (screen: string, input: unknown) => {
  const as = (input as { kept_as?: unknown } | undefined)?.kept_as;
  return keptAt(typeof as === 'string' && as ? `${screen}::${as}` : screen);
};

/** Arranges a screen, or stops: shows or hides its arrangement's chrome wherever it is open on this page. */
export function setArranging(screen: string, on: boolean): void {
  if (on === arranging.has(screen)) return;
  if (on) arranging.add(screen); else arranging.delete(screen);
  redraw(screen);
}

/** Forgets the arrangement a screen opened on `input` keeps (keptOf): it opens there as it started, everywhere. */
export async function putScreenBack(screen: string, input?: unknown): Promise<void> {
  arranging.delete(screen);
  await sendRequestToBitfieldTarget({ target: ENGINE_OPERATION_TARGET, payload: { operation_label: ENGINE_WRITE_BATCH_OPERATION_LABEL, writes: [{ address_label: keptOf(screen, input), payload: null }] } });
  redraw(screen);
}

// The rows a screen's ⋯ offers for arranging it (the pane's ⋯ is about the screen it shows).
providePageRows((thing: Thing) => {
  if (thing.kind !== 'screen' || !thing.id) return [];
  const screen = thing.id;
  const on = arranging.has(screen);
  return [
    on
      ? { id: 'arrange:done', label: data.words.done, icon: 'Check', run: async () => { setArranging(screen, false); return data.words.done_said; } }
      : { id: 'arrange:start', label: data.words.arrange, icon: 'LayoutDashboard', run: async () => { setArranging(screen, true); return data.words.arrange_said; } },
    ...(readRecordAt(keptOf(screen, thing.input)) !== null ? [{ id: 'arrange:back', label: data.words.back, icon: 'RotateCcw', run: async () => { await putScreenBack(screen, thing.input); return data.words.back_said; } }] : []),
  ];
});

// How a lead screen is mounted: the page's runner hands its own mount (screen-runner.ts), so a lead draws exactly as it
// would in a pane.
type LeadMount = (element: HTMLElement, screen: string) => Unmount;
let leadMount: LeadMount | null = null;
export function provideLeadMount(mount: LeadMount): void { leadMount = mount; }

/** Draws `leads` above the arrangement in `element`, returning where the arrangement goes and the leads' cleanup. */
function withLeads(element: HTMLElement, leads: string[]): { body: HTMLElement; release: Unmount } {
  if (!leads.length || !leadMount) return { body: element, release: () => {} };
  const top = document.createElement('div');
  top.className = 'screen-leads';
  const body = document.createElement('div');
  body.className = 'screen-leads-body';
  element.setAttribute('data-has-leads', '');
  element.replaceChildren(top, body);
  const releases = leads.map(screen => { const host = document.createElement('div'); host.className = 'screen-lead'; top.append(host); return leadMount!(host, screen); });
  return { body, release: () => { for (const release of releases) release(); element.removeAttribute('data-has-leads'); element.replaceChildren(); } };
}

/** The arrangement mount props the window was given (main.tsx), so a nested arrangement offers the same screens,
 *  lists and kept layouts. Set once at start; a page without a window (the AI-app view) offers the app's screens. */
let windowProps: Record<string, unknown> = { placeableSurfaceListAddressLabel: surfaces.address_label };
export function useWindowArrangement(props: Record<string, unknown>): void { windowProps = props; }

/**
 * Mounts `screen` (an offered screen id, opened on `input`) into `element`: inside its own arrangement when it has
 * one or is being arranged, else bare through `mountBare` (invariant 3). Follows changes (arranging, an AI's write)
 * until the returned cleanup runs.
 */
export function mountScreenArranged(element: HTMLElement, screen: string | null, input: Record<string, unknown>, mountBare: (element: HTMLElement) => Unmount): Unmount {
  if (!screen) return mountBare(element);
  // A screen that is itself an arrangement of other screens opens on it (invariant 4): the arrangement its input
  // names (one placed with its own, a tab of the menu bar panel) or its row's (Home); any other opens on itself as
  // its one pane. One placed with its own is kept by its own name (`kept_as`), so each such place is its own.
  const row = offeredScreens().find(one => one.id === screen);
  const given = input as { arrangement?: unknown; arrangement_chrome?: Record<string, unknown>; kept_as?: unknown };
  const declared = given.arrangement ?? (row?.surface_input as typeof given | undefined)?.arrangement;
  const starter = declared ?? { kind: 'pane', surfaces: [{ id: screen, input, ...(typeof row?.label === 'string' ? { title: row.label } : {}) }] };
  const leads = ((row?.surface_input as { leads?: unknown } | undefined)?.leads ?? []) as string[];
  const chromeOf = (mode: 'arranged' | 'arranging') => given.arrangement_chrome?.[mode] ?? data.chrome[mode];
  const kept = keptOf(screen, given);
  // Inside its own arrangement: itself (invariant 2). A screen that is only its arrangement (Home) has no self to draw,
  // so placed inside itself it draws its starting arrangement as its own place, kept apart from the one around it.
  const inside = element.parentElement?.closest(`[${ARRANGED}="${CSS.escape(kept)}"]`);
  // Twice inside itself draws itself bare, so no arrangement can hold itself without end.
  if ((inside && !declared) || element.parentElement?.closest(`[${ARRANGED}="${CSS.escape(`${kept}::inside`)}"]`)) return mountBare(element);
  const keptHere = inside ? `${kept}::inside` : kept;
  // How the screen is drawn: bare, arranged (its pieces read as one screen) or being arranged (with chrome). Saving
  // while being arranged changes nothing drawn, so a drag never remounts what it is dragging.
  let shown: 'bare' | 'arranged' | 'arranging' | null = null;
  let release: Unmount = () => {};
  const draw = () => {
    const next = arranging.has(screen) ? 'arranging' : declared || readRecordAt(keptHere) !== null ? 'arranged' : 'bare';
    if (next === shown) return;
    release();
    shown = next;
    if (next === 'bare') {
      element.removeAttribute(ARRANGED);
      release = mountBare(element);
      return;
    }
    element.setAttribute(ARRANGED, keptHere);
    const led = withLeads(element, Array.isArray(leads) ? leads.filter(lead => typeof lead === 'string') : []);
    const nested = mountNested({ el: led.body, props: { ...windowProps, keptAt: keptHere, starter, chrome: chromeOf(next), stackRowsThatDoNotFit: data.stack_rows_that_do_not_fit } });
    release = () => { nested(); led.release(); };
  };
  draw();
  const listeners = redraws.get(screen) ?? new Set();
  listeners.add(draw);
  redraws.set(screen, listeners);
  // An AI (or another device) arranging this screen, or putting it back, redraws it here.
  const stopHearing = subscribeRecordChanges(labels => { if (labels.includes(keptHere)) draw(); });
  return () => { listeners.delete(draw); stopHearing(); release(); element.removeAttribute(ARRANGED); };
}

/** Screens together (entry `screens-together`) is only its arrangement (its row's, or the one it is placed with), which
 *  every host draws; drawn bare (an arrangement holding it twice inside itself) it holds nothing and says nothing. */
export function mountScreensTogether(element: HTMLElement): Unmount {
  element.replaceChildren();
  return () => element.replaceChildren();
}
