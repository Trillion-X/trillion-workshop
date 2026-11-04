// parts/screen-arrangement/show/floating-window-context.ts
//
// Purpose: the context a floating window's header reads to start a drag or a resize. Its own file, so the headers every
// layout draws (ContainerHeader.tsx, stable-container-content.tsx) do not load the canvas (FreeformArranger.tsx),
// which is fetched only when a layer is laid out as one.
import React from 'react'

export const FloatingWindowContext = React.createContext<{
  onStartDrag?: (containerId: string, e: React.PointerEvent) => void
  onStartResize?: (containerId: string, edge: string, e: React.PointerEvent) => void
} | null>(null)
