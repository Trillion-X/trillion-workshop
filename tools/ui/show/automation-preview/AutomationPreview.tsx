// parts/ui/show/automation-preview/AutomationPreview.tsx
//
// PURPOSE
//   A setting or control that something automatic stands behind (a rule, a schedule or a workflow) says so in its
//   DATA with that automation's id. Resting the pointer on it, or focusing it, opens a card with a small read-only
//   graph of what it does (a workflow's steps; a rule or schedule as "what sets it off" -> "what it does"), and
//   pressing it opens that automation in its editor.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this part names no automation, no route and no graph drawer. The app registers one source
//      (setAutomationPreviewSource) with how to read an id's graph, how to draw it, and how to open it; every control
//      that carries an automation id shares it, wherever it is mounted (inside another part's own React root too).
//   2. A graph is read only when its card opens, and once per id while the page is open unless it is forgotten.
//   3. Hover and keyboard focus both open the card (Base UI PreviewCard); the press opens the editor.
//   4. Appearance lives in screen-look/show/automation-preview.css and the record-preview card look.

import React, {useEffect, useState} from 'react'
import {PreviewCard} from '@base-ui/react/preview-card'
import {Button} from '../coss/ui/button'
import {NamedIcon} from '../icon'
import {LAYER_ORDER} from '../layer-order/layer-order'
import {safeEdgePadding} from '../visible-viewport/safe-area-insets'
import {CARD_CONTROLS, cardShown} from '../hover-preview/card-shown'
import {useShowChange} from '../show-rules/show-of'

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
/** What a card draws: a title, one line of plain words, and a graph in the app's own graph shape. */
export type AutomationPreviewGraph = {title: string; says?: string; source: unknown}

export type AutomationPreviewSource = {
  read: (id: string) => Promise<AutomationPreviewGraph>
  /** Draws a graph small and still. */
  drawGraph: (graph: AutomationPreviewGraph) => React.ReactNode
  open: (id: string, title: string) => void
}

let source: AutomationPreviewSource | null = null
const read = new Map<string, Promise<AutomationPreviewGraph>>()

/** The app's one way to read, draw and open automations. Setting it again forgets what was read. */
export function setAutomationPreviewSource(next: AutomationPreviewSource) {
  source = next
  read.clear()
}

/** Forgets one id's graph (after it was changed), so its next card reads it again. */
export function forgetAutomationPreview(id: string) { read.delete(id) }

function PreviewBody({id}: {id: string}) {
  const [graph, setGraph] = useState<AutomationPreviewGraph | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!source) { setProblem('Nothing can be shown here yet.'); return }
    let alive = true
    if (!read.has(id)) read.set(id, source.read(id).catch(error => { read.delete(id); throw error }))
    read.get(id)!.then(value => { if (alive) setGraph(value) }, error => { if (alive) setProblem(errorWords(error)) })
    return () => { alive = false }
  }, [id])
  if (problem) return <p className="automation-preview-said" data-tone="error">{problem}</p>
  if (!graph) return <p className="automation-preview-said">Loading what it does</p>
  return (
    <>
      <div className="automation-preview-heading">
        <NamedIcon name="Zap" size="sm" aria-hidden/>
        <p className="automation-preview-title">{graph.title}</p>
      </div>
      {graph.says ? <p className="automation-preview-said">{graph.says}</p> : null}
      <div className="automation-preview-graph" data-automation-preview-graph={id}>{source?.drawGraph(graph)}</div>
      <Button size="xs" variant="outline" className="automation-preview-open" onClick={() => source?.open(id, graph.title)}>
        <NamedIcon name="PencilLine" size="xs" aria-hidden/>Open to edit
      </Button>
    </>
  )
}

/** Something automatic a setting stands on, as a screen's DATA names it: the id its card reads, its name, on or off. */
export type BackingAutomation = {id: string; label: string; on?: boolean}

/** A small mark beside a heading or column name for each automation behind it, each with its own card. */
export function AutomationMarks({automations}: {automations?: BackingAutomation[]}) {
  if (!automations?.length) return null
  return (
    <span className="automation-marks" data-automation-marks>
      {automations.map(automation => (
        <AutomationPreview key={automation.id} automationId={automation.id} title={automation.label}>
          <NamedIcon name="Zap" size="xs" aria-label={`${automation.label}${automation.on === false ? ' (off)' : ''}`}/>
        </AutomationPreview>
      ))}
    </span>
  )
}

export type AutomationPreviewProps = {
  /** The automation behind this control, as the app names it. */
  automationId: string
  /** Its name, for the editor tab until the graph is read. */
  title: string
  /** The control or words the card belongs to. A press on them opens the editor; a control that handles its own
   *  press (a switch, a button) stops it, so it keeps doing its own job. */
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
  /** The card's control (hover-preview/card-shown.ts); the ui part's automations card when not named. */
  control?: string
}

export function AutomationPreview({automationId, title, children, side = 'bottom', delay = 350, control = CARD_CONTROLS.automation}: AutomationPreviewProps) {
  useShowChange()
  const open = () => source?.open(automationId, title)
  const trigger = (
    <span
      className="automation-preview-trigger"
      role="button"
      tabIndex={0}
      data-automation-id={automationId}
      onClick={event => { event.stopPropagation(); open() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open() } }}
    >
      {children}
    </span>
  )
  if (!cardShown(control)) return trigger
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={trigger} delay={delay} closeDelay={150}/>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side={side} align="start" sideOffset={8} collisionPadding={safeEdgePadding(12)} style={{zIndex: LAYER_ORDER.menu}}>
          <PreviewCard.Popup className="coss-ui record-preview automation-preview" data-slot="automation-preview">
            <PreviewBody id={automationId}/>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}
