// parts/screen-arrangement/show/publish-shown-arrangement.tsx
//
// PURPOSE
//   Keeps the arrangement on screen readable by the person's AIs: each time it changes, the arrangement is written to
//   the person's records as the starter shape (read-data/starter-layouts.ts starterArrangementOf) under
//   SHOWN_ARRANGEMENT_LABEL, with when it was shown. src/layouts.mjs answers read_layouts `current` from that record,
//   so an AI rearranges what the person sees by changing that DATA and handing it back to save_layout. The arrangement
//   itself stays kept where the arrangement keeps it (this browser); this is what it shows, published. Mounted once
//   inside the arrangement (LayoutEngine); draws nothing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Written only when the shape changes (compared as JSON): a focus move or a tab's title changing writes nothing.
//   2. Blind: nothing here names a screen; the shape is starterArrangementOf's.
//   3. A write that fails leaves the screen as it is; the next change writes again.

'use client'

import * as React from 'react'
import { buildEngineWriteBatchRequestFromLabels, sendRequestToBitfieldTarget } from '#workspace-records'
import { starterArrangementOf } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/starter-layouts.ts'
import { LayoutStateContext } from './screen-arrangement-context'

/** The record the arrangement on screen is published to, read by src/layouts.mjs (src/layouts.json shown_label). */
export const SHOWN_ARRANGEMENT_LABEL = 'screen-arrangement-shown'

export function PublishShownArrangement(): null {
  const layoutState = React.useContext(LayoutStateContext)
  const written = React.useRef<string | null>(null)
  const arrangement = React.useMemo(() => starterArrangementOf(layoutState), [layoutState])
  React.useEffect(() => {
    if (!arrangement) return
    const shape = JSON.stringify(arrangement)
    if (shape === written.current) return
    written.current = shape
    void sendRequestToBitfieldTarget(buildEngineWriteBatchRequestFromLabels([
      { addressLabel: SHOWN_ARRANGEMENT_LABEL, payload: { arrangement, shown_at: new Date().toISOString() } },
    ])).catch(() => { written.current = null })
  }, [arrangement])
  return null
}
