// src/workspace/screen-mounts.ts
//
// PORTED FROM: src/workspace/main.tsx (its screens list, moved here in 092459a7 so screen-view.tsx mounts the same list).
//
// PURPOSE
//   Every screen the workspace can mount, by its entry name (a surface row's `package_entry.entry_name`): the one list
//   both the signed-in page (main.tsx, its panes) and the screen view an AI app draws (screen-view.tsx) mount from, so
//   a screen shown inside a chat is the same screen, never a copy.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Each screen's code is its own file, fetched the first time the screen opens (lazy-screen.ts); the build reads
//      this list to know each screen's files (scripts/build-workspace.mjs).
//   2. A screen that holds other screens (Home's board, a tool's own screen) mounts them from this same list.
//   3. A screen that is its tool folder's own code (a screen module: the board, Write) is not listed here; it opens
//      through 'tool-screen' (tool-screen.tsx, kind `module`).

import { lazyScreen, type ScreenProps, type WarmMount } from './lazy-screen';
import { recordFilter } from './record-filter';

// Each screen's code is its own file, fetched the first time the screen opens (lazy-screen.ts).
export const screens: Record<string, WarmMount> = {
  'screens-together': lazyScreen(() => import('./screen-own-arrangement'), module => module.mountScreensTogether),
  guide: lazyScreen(() => import('./guide-screens'), module => module.mountGuideScreen),
  // Every tool that carries its own screen opens here (tool-screen.tsx); an app-entry screen mounts one of these.
  'tool-screen': lazyScreen(() => import('./tool-screen'), module => (element: HTMLElement, props: ScreenProps) => module.mountToolScreen(element, props, screens)),
  // The one notification center (parts/ui): its screen, and the short live feed its bell shows on hover. The panel and
  // its record views are their own file (notification-panel.tsx); the toasts stay in the first load.
  notifications: lazyScreen(() => import('../../parts/ui/show/coss/notification-panel'), module => (element: HTMLElement) => module.mountNotificationPanel(element, { recordFilter })),
  'notifications-preview': lazyScreen(() => import('../../parts/ui/show/coss/notification-panel'), module => (element: HTMLElement) => module.mountNotificationPanel(element, { compact: true })),
  // The message box every screen can open (global-composer.tsx): its row floats it over the work in a layer.
  'message-box': lazyScreen(() => import('./global-composer'), module => module.mountMessageBoxScreen),
  // Find anything (command-palette.tsx): its row floats it in the middle in its own layer; Cmd+K opens it.
  'command-palette': lazyScreen(() => import('./command-palette'), module => module.mountCommandPaletteScreen),
  // The screen of tool:screen-looks (records/workshop-account-tool-records.json screen.entry): the card grid of looks.
  'screen-look': lazyScreen(() => import('../../parts/screen-look/show/mount-screen-look-full-surface'), module => (element: HTMLElement, props: ScreenProps) => module.default({ el: element, props })),
};
