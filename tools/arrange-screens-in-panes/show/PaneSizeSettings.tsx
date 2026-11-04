// parts/screen-arrangement/show/PaneSizeSettings.tsx
//
// NO PRIOR: searched 'pane size|snap|split settings' in ~/dev/bitfield-packages/packages/*/show; searched 'resizable panels with snap points' on the 21st.dev MCP; searched 'layout settings with panel sizes and snapping preview' on Mobbin
//
// PURPOSE
//   Panes: how small a pane gets, how much a new split takes, and where a dragged
//   edge snaps, as the shared TuningPanel beside a small window to drag in. Each
//   change is kept at once, so the real panes around it follow too.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The rows are pane-sizes.json's; nothing here names a setting.
//   2. The preview snaps through snapPanePx, the same function the panes use.

import React, { useEffect, useState } from 'react'
import { TuningPanel, TuningSplitPreview, type TuningValue } from '../../ui'
import { PANE_SIZE_SECTIONS, snapPanePx, type PaneSizes } from '../read-data/pane-sizes'
import { usePaneSizes, writePaneSizes } from './use-pane-sizes'

function useScreenWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return width
}

export function PaneSizeSettings() {
  const sizes = usePaneSizes()
  const screenWidth = useScreenWidth()
  return (
    <TuningPanel
      sections={PANE_SIZE_SECTIONS}
      values={sizes as unknown as Record<string, TuningValue>}
      onChange={(key, value) => {
        if (value === undefined) return
        void writePaneSizes(sizes, { [key]: value } as Partial<PaneSizes>)
      }}
      preview={(
        <TuningSplitPreview
          stagePx={screenWidth}
          minPx={sizes.drag_minimum_px}
          marksPercent={sizes.snap_on ? sizes.snap_points_percent.map(Number) : []}
          easeMs={sizes.snap_ease_ms}
          startShare={sizes.new_pane_share_percent / 100}
          snap={(px, stagePx) => snapPanePx(px, stagePx, sizes)}
        />
      )}
    />
  )
}
