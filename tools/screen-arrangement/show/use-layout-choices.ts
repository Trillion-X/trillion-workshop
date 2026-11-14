// parts/screen-arrangement/show/use-layout-choices.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The layouts a person can open right now, read once for every place that
// offers them: the Layouts picker (sidebar and empty pane) and scrolling past
// the edge of the arrangement. It reads the kept layouts from the account,
// adds the layouts the person's AIs made and the host's starters, orders them through the one order
// (do-work/switch-saved-layout.ts layoutChoices), finds which one is on screen,
// and opens a choice through the one switch.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Every opening goes through switchSavedLayoutWithRecovery, with this
//    person's starters so a starter is never kept again.
// 2. Any change to the saved layouts is announced, and every reader on the page
//    reads them again (SAVED_LAYOUTS_CHANGED_EVENT).
// 3. The layout on screen is the choice whose signature equals the current
//    arrangement's; when none does, `currentIndex` is -1.
// 4. Whether a layout is offered is the person's show rules (parts/ui
//    show-rules, subject `layout`, facts its id and name): a hidden one leaves
//    `choices` (the Layouts menu, scrolling past the edge) while it is hidden,
//    and is still in `every`, so a layout asked for by name opens.
//
// =============================================================================

'use client'

import * as React from 'react'
import { useBitfieldData } from '#workspace-records'
import { starterLayoutState, readStarterLayouts } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/starter-layouts.ts'
import type { GroupSavedLayout } from '../do-work/save-arrangement-as-group'
import {
  SAVED_LAYOUTS_CHANGED_EVENT,
  announceSavedLayoutsChanged,
  layoutChoices,
  loadSavedLayoutGroups,
  savedLayoutSignature,
  switchSavedLayoutWithRecovery,
  type LayoutChoice,
} from '../do-work/switch-saved-layout'
import { showOf, useShowChange } from '../../ui/show/show-rules/show-of'
import { ArrangementHostDataContext, LayoutActionsContext, LayoutStateContext, OfferedSurfacesContext } from './screen-arrangement-context'

/** The layouts the person's AIs made (src/layouts.mjs), read by this input name. */
export const OWN_LAYOUTS_INPUT = 'own-layouts'

/** What a layout is to the person's show rules (invariant 4). */
const LAYOUT_SUBJECT = 'layout'

export type LayoutChoices = {
  /** The layouts offered now: every layout the show rules do not hide. */
  choices: LayoutChoice[]
  /** Every layout, hidden ones too, for a layout asked for by name. */
  every: LayoutChoice[]
  /** Where the arrangement on screen sits in `choices`, or -1 when it is none of them. */
  currentIndex: number
  currentSignature: string | null
  /** The kept layouts as last read from the account (Previous layout included). */
  saved: GroupSavedLayout[]
  loaded: 'loading' | 'ready' | 'failed'
  refresh: () => Promise<void>
  /** Take a list read back from the account after a change, and tell the page. */
  takeSaved: (saved: GroupSavedLayout[]) => void
  /** Open a layout through the one switch. Rejects when it could not be opened; the screen is then as it was. */
  open: (choice: LayoutChoice) => Promise<void>
}

export function useLayoutChoices(): LayoutChoices {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const hostData = React.useContext(ArrangementHostDataContext)
  const offered = React.useContext(OfferedSurfacesContext)
  const [saved, setSaved] = React.useState<GroupSavedLayout[]>([])
  const [loaded, setLoaded] = React.useState<'loading' | 'ready' | 'failed'>('loading')

  const refresh = React.useCallback(async () => {
    try {
      setSaved(await loadSavedLayoutGroups())
      setLoaded('ready')
    } catch {
      setLoaded('failed')
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    window.addEventListener(SAVED_LAYOUTS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(SAVED_LAYOUTS_CHANGED_EVENT, refresh)
  }, [refresh])

  // The person's AIs' layouts (src/layouts.mjs, the same starter DATA) come first, newest first, then the host's starters.
  const ownLayouts = useBitfieldData(OWN_LAYOUTS_INPUT)
  const starters = React.useMemo(() => readStarterLayouts([
    ...(Array.isArray(ownLayouts) ? ownLayouts : []),
    ...(Array.isArray(hostData.starterLayouts) ? hostData.starterLayouts : []),
  ]).flatMap((starter) => {
    const layout = starterLayoutState(starter, offered)
    return layout ? [{ id: starter.id, name: starter.name, layout, meta: {} } satisfies GroupSavedLayout] : []
  }), [ownLayouts, hostData.starterLayouts, offered])

  const every = React.useMemo(() => layoutChoices(starters, saved), [saved, starters])
  const showRevision = useShowChange()
  const choices = React.useMemo(
    () => every.filter((choice) => !showOf(LAYOUT_SUBJECT, { id: choice.preset.id, name: choice.preset.name }).hidden),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showRevision is how a rule change asks again
    [every, showRevision],
  )
  const currentSignature = React.useMemo(() => (layoutState ? savedLayoutSignature(layoutState) : null), [layoutState])
  const currentIndex = currentSignature === null ? -1 : choices.findIndex((choice) => choice.signature === currentSignature)

  const takeSaved = React.useCallback((next: GroupSavedLayout[]) => {
    setSaved(next)
    setLoaded('ready')
    announceSavedLayoutsChanged()
  }, [])

  const open = React.useCallback(async (choice: LayoutChoice) => {
    if (!layoutState || !layoutActions) throw new Error('There is no arrangement on screen to switch from.')
    const refreshed = await switchSavedLayoutWithRecovery({
      currentLayout: layoutState,
      preset: choice.preset,
      applyLayoutState: layoutActions.applyLayoutState,
      starterLayouts: starters.map((starter) => starter.layout),
    })
    if (refreshed) takeSaved(refreshed)
  }, [layoutActions, layoutState, starters, takeSaved])

  return { choices, every, currentIndex, currentSignature, saved, loaded, refresh, takeSaved, open }
}
