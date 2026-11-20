// tools/keep-lists-of-rows/web/lists-screen-mount.tsx
//
// PURPOSE
//   A list as a screen module: the one file a screen row names (`screen.module.entry`), whose `mount(element, props)` is the
//   module contract (web/src/workspace/tool-screen.tsx). The list the screen shows is the row's `id` input (for example
//   `posts`), read through the list's own screen (src/workspace/lists-screen.tsx).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The screen gives the list screen the input it was mounted with and nothing else.

import { mountListScreen } from './src/workspace/lists-screen';

export function mount(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}) {
  return mountListScreen(element, { surfaceInput: props.surfaceInput ?? {} });
}
