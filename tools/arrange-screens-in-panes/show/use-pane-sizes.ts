// parts/screen-arrangement/show/use-pane-sizes.ts
//
// PURPOSE
//   The person's pane sizes (how small a pane gets, what a new split takes, where a dragged edge snaps) read from
//   their workspace preference over the DATA defaults, handed to read-data/pane-sizes.ts so geometry reads them, and
//   saved from the Panes settings. A change is kept in the person's records at once, so every arrangement on every
//   device redraws with it.

import { useEffect, useMemo } from 'react'
import { useWorkspacePreference, writeWorkspacePreference } from '#workspace-records'
import { PANE_SIZES_PREFERENCE, readPaneSizes, setPaneSizesNow, type PaneSizes } from '../read-data/pane-sizes'

export function usePaneSizes(): PaneSizes {
  const own = useWorkspacePreference<Partial<PaneSizes>>(PANE_SIZES_PREFERENCE)
  const sizes = useMemo(() => readPaneSizes(own), [own])
  // Set during render so the panes drawn in this same render already use the person's sizes.
  setPaneSizesNow(sizes)
  useEffect(() => { setPaneSizesNow(sizes) }, [sizes])
  return sizes
}

/** Keep one or more of the person's pane sizes; the rest stay as they were. */
export function writePaneSizes(sizes: PaneSizes, change: Partial<PaneSizes>): Promise<unknown> {
  return writeWorkspacePreference(PANE_SIZES_PREFERENCE, { ...sizes, ...change })
}
