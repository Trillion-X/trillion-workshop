// parts/screen-arrangement/show/open-asked-layout.tsx
//
// PURPOSE
//   Opens a layout the person's AI asked to open now (src/layouts.mjs writes `{ layout_id, asked_at }`, read here by
//   the input `layout-open-asked`), once per ask, through the one switch every Layouts entry uses, so the arrangement
//   it replaces is kept as Previous layout first. Mounted once inside the arrangement (LayoutEngine); draws nothing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every opening goes through useLayoutChoices().open (switchSavedLayoutWithRecovery).
//   2. An ask is acted on once per browser and never when it was already old as the page opened (useAskedNow).
//   3. An ask waits until the layouts are read; an ask naming no layout this person is offered opens nothing.

'use client'

import { useBitfieldData } from '#workspace-records'
import { useAskedNow } from '../../ui/show/asked-now/use-asked-now'
import { useLayoutChoices } from './use-layout-choices'

/** The AI's ask to open one layout now, read by this input name. */
export const LAYOUT_OPEN_ASKED_INPUT = 'layout-open-asked'

export function OpenAskedLayout(): null {
  const asked = useBitfieldData(LAYOUT_OPEN_ASKED_INPUT)
  const { every, loaded, open } = useLayoutChoices()
  const askedId = asked && typeof asked === 'object' ? (asked as { layout_id?: unknown }).layout_id : null
  // A layout asked for by name opens even while a show rule keeps it out of the Layouts menu.
  const choice = every.find((one) => one.preset.id === askedId)
  useAskedNow(asked, 'screen-arrangement:open-asked-seen', () => {
    if (choice) void open(choice).catch((error) => console.error('The layout your AI asked for could not open', error))
  }, loaded !== 'loading' && !!choice)
  return null
}
