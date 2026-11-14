// src/workspace/web-address-screen.tsx
//
// PURPOSE
//   The `web-address` tool screen (tool-screen.tsx SHOWS): the tool's own hosted frontend, opened from here. tool-screen.tsx
//   fetches this the first time such a screen opens, so a module or workspace screen never carries the guide it draws with.
//
// NON-NEGOTIABLE INVARIANTS
//   Those of tool-screen.tsx, whose screen this is.

import { guideScreen } from './guide-screen';
import { aboutOf, nameOf, type Show } from './tool-screen';

export const webAddress: Show = (element, tool, screen) => {
  const guide = guideScreen(element, 'Loading the tool', async () => ({
    title: nameOf(tool, screen),
    hide_header: true,
    sections: [{ profile: { name: nameOf(tool, screen), detail: aboutOf(tool, screen), action: { label: 'Open', tone: 'primary', icon: 'ArrowUpRight', href: screen.url } } }],
  }));
  return () => guide.unmount();
};
