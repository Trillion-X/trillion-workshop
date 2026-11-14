// src/workspace/screen-runner.ts
//
// PORTED FROM: src/workspace/main.tsx (its on-screen runner, moved here so the AI-app screen view mounts arranged
// screens the same way).
//
// PURPOSE
//   The page's on-screen runner: the arrangement (at every depth) asks it to put
//   `package::<app>::entry-bytes::<entry>` in a pane, and it mounts the app's own screen from `screens`, inside the
//   screen's own arrangement when it has one (screen-own-arrangement.ts). The signed-in page and the AI-app screen view
//   both install it, so a screen made of screens (Home) and any arranged screen draws the same in either.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One runner per page, installed once; every pane of every nested arrangement mounts through it.
//   2. A label naming no screen of this app says so in words and mounts nothing.
//   3. What a page adds around a screen (examples, tours, what is new) is the page's `around`, never here.

import { mountScreenState } from '../../parts/ui/show/screen-state';
import type { ScreenProps, Unmount, WarmMount } from './lazy-screen';
import { offeredScreens, goTo, surfaceOf } from './open-screen';
import { mountScreenArranged, provideLeadMount } from './screen-own-arrangement';

type Request = { sourceBytes?: { address_label?: string }; screenPlace?: HTMLElement | { element: HTMLElement }; props?: ScreenProps };
type Hosted = HTMLElement & { _thingToPutOnScreenCleanup?: Unmount | null };
/** What a page draws around a screen it mounts: given the pane, what it shows and the mount of the screen itself. */
export type Around = (element: HTMLElement, shown: { entry: string; input: Record<string, unknown> }, mount: (element: HTMLElement) => Unmount) => Unmount;

/** Installs the runner for an app whose screens list is `addressLabel` (`placeable-surface-list::<app>`). */
export function installScreenRunner(screens: Record<string, WarmMount>, addressLabel: string, around: Around = (element, _shown, mount) => mount(element)): void {
  const prefix = `package::${addressLabel.split('::').at(-1)}::entry-bytes::`;
  (globalThis as Record<string, unknown>).__THINGS_TO_PUT_ON_SCREEN__ = {
    putSourceBytesOnScreen(request: Request) {
      const place = request.screenPlace;
      const element = (place && 'element' in place ? place.element : place) as Hosted;
      const label = request.sourceBytes?.address_label ?? '';
      const mount = label.startsWith(prefix) ? screens[label.slice(prefix.length)] : undefined;
      if (!mount) {
        mountScreenState(element, { status: 'empty', icon: 'LayoutPanelLeft', title: 'This screen is not part of Trillion', description: 'Close this tab and open a screen from the sidebar.', action: goTo('Open Home', 'trillion.home') });
        element._thingToPutOnScreenCleanup = () => element.replaceChildren();
        return undefined;
      }
      const entry = label.slice(prefix.length);
      const input = request.props?.surfaceInput ?? {};
      // Which screen this pane holds, so a tour step can point inside it (`[data-trillion-screen="tool-screen"] ...`).
      element.dataset.trillionScreen = typeof input.screen === 'string' ? input.screen : entry;
      element._thingToPutOnScreenCleanup = around(element, { entry, input }, place => mountScreen(place, entry, input, body => mount(body, request.props ?? {})));
      return undefined;
    },
    prewarmSourceBytes() { return undefined; },
  };
  // A screen's leads (screen-own-arrangement.ts invariant 6) mount here, as any pane's screen does.
  provideLeadMount((element, screen) => {
    const row = offeredScreens().find(one => one.id === screen) as { package_entry?: { entry_name?: string }; surface_input?: Record<string, unknown> } | undefined;
    const entry = row?.package_entry?.entry_name;
    const mount = entry ? screens[entry] : undefined;
    if (!mount) return () => {};
    const input = row?.surface_input ?? {};
    element.dataset.trillionScreen = typeof input.screen === 'string' ? input.screen : entry!;
    return mountScreenArranged(element, screen, input, body => mount(body, { surfaceInput: input, mountRole: 'lead' }));
  });
}

/** Mounts one screen of this app, by its entry and input, inside its own arrangement when it has one. */
export function mountScreen(element: HTMLElement, entry: string, input: Record<string, unknown>, mountBare: (element: HTMLElement) => Unmount): Unmount {
  return mountScreenArranged(element, surfaceOf(offeredScreens() as never, entry, input), input, mountBare);
}
