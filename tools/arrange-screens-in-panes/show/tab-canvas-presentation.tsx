// parts/screen-arrangement/show/tab-canvas-presentation.tsx
//
// Purpose: a tab's content shown on a pannable, zoomable canvas (the shared graph canvas, one node holding the tab).
// Its own file, fetched by ContainerHost.tsx the first time a tab is shown as a canvas, so a layout of ordinary tabs
// does not load the canvas.
import React from 'react'
import { GraphCanvas } from '../../graph-canvas/show/GraphCanvas'
import { useGraphCanvas } from '../../graph-canvas/show/use-graph-canvas'
import type { CanvasNodeFrame } from '../../graph-canvas/show/types'

export default function TabCanvasPresentation({ children }: { children: React.ReactNode }) {
  const canvasRef = React.useRef<HTMLDivElement | null>(null)
  const nodes = React.useMemo<CanvasNodeFrame[]>(() => [
    { id: 'tab-content', x: 48, y: 48, width: 960, height: 640 },
  ], [])
  const {
    camera,
    selectedNodeId,
    selectNode,
    draggedNodeId,
    draggedNodePosition,
    startCanvasPan,
    updateNodeDragPosition,
    endNodeDrag,
    zoomToFit,
  } = useGraphCanvas({
    nodes,
    canvasRef,
    initialCamera: { zoom: 1, pan_x: 0, pan_y: 0 },
    enableNodeDrag: false,
  })
  const renderNode = React.useCallback(() => (
    <div
      className="h-full w-full overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--surface-primary)] shadow-2xl"
      data-graph-node-interactive="true"
    >
      {children}
    </div>
  ), [children])

  return (
    <div className="relative flex flex-1 min-h-0 w-full overflow-hidden">
      <GraphCanvas
        nodes={nodes}
        renderNode={renderNode}
        camera={camera}
        selectedNodeId={selectedNodeId}
        draggedNodeId={draggedNodeId}
        draggedNodePosition={draggedNodePosition}
        selectNode={selectNode}
        updateNodeDragPosition={updateNodeDragPosition}
        endNodeDrag={endNodeDrag}
        zoomToFit={zoomToFit}
        canvasRef={canvasRef}
        onCanvasPointerDown={(event) => {
          const target = event.target instanceof Element ? event.target : null
          if (target?.closest('[data-graph-node]')) return
          event.currentTarget.setPointerCapture(event.pointerId)
          startCanvasPan(event.clientX, event.clientY)
        }}
      />
    </div>
  )
}
