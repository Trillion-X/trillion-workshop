// parts/ui/show/swipe-deck/SwipeDeck.tsx
//
// PORTED FROM: design-systems/21st-dev/swipe-deck/swipe-deck.tsx.source (21st.dev "Swipe Deck" by ddoemonn,
//   https://21st.dev/@ddoemonn/components/swipe-deck, public registry component 23568): the deck hook (decisions, undo,
//   intent steps, threshold or flick release, arrow keys and Backspace) and the stacked card with its drag, tilt, fade,
//   peek and exit throw. Changed for Trillion: imports from framer-motion (the package the workspace ships), every
//   colour from the screen-look tokens instead of fixed stone and blue values, the shared Button and NamedIcon instead
//   of hand-drawn buttons and svg glyphs, a third way to decide (up, Enter, or a press without a drag opens the card)
//   and a Start again once every card is seen.
//
// PURPOSE
//   A deck of cards decided one at a time: drag or throw the top card left or right, press the arrow keys, or press the
//   buttons under it; Backspace or Undo brings the last one back. The caller draws each card and says what each side
//   means; the deck knows nothing about what it holds.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no kind of item, word or meaning is named here; labels, icons and what a choice does are the caller's.
//   2. A press that did not drag opens the card (onOpen); a drag never opens it.
//   3. Reduced motion skips every animation and keeps every decision.

import * as React from 'react'
import {AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform} from 'framer-motion'
import {Button} from '../coss/ui/button'
import {NamedIcon} from '../icon'

const CELL = {type: 'spring', stiffness: 520, damping: 34, mass: 0.45} as const
const DISCLOSE = {type: 'spring', stiffness: 150, damping: 27, mass: 1} as const
const CROSSFADE = {type: 'spring', stiffness: 260, damping: 34, mass: 0.8} as const
const LEAVE = [0.4, 0, 1, 1] as const

export type SwipeChoice = 'left' | 'right'
export type SwipeIntent = {dir: -1 | 0 | 1; step: number}
export type SwipeDeckFlow = {dir: -1 | 1; kind: 'decide' | 'undo'}
const BLANK: SwipeIntent = {dir: 0, step: 0}
// How far each card under the top one shows below it, and how much smaller it is, so the deck reads as a stack.
const PEEK_STEP = 14
const PEEK_SHRINK = 0.05
/** The look's colour a side is drawn in when the top card leans toward it. */
export type SwipeTone = 'success' | 'destructive' | 'warning' | 'info' | 'primary' | 'muted'
// Whole class names, so the stylesheet build sees each one: the stamp's words and edge, and the wash over the card.
const TONE_CLASSES: Record<SwipeTone, {stamp: string; wash: string}> = {
  success: {stamp: 'text-status-success border-status-success', wash: 'bg-status-success'},
  warning: {stamp: 'text-status-warning border-status-warning', wash: 'bg-status-warning'},
  destructive: {stamp: 'text-status-error border-status-error', wash: 'bg-status-error'},
  info: {stamp: 'text-status-info border-status-info', wash: 'bg-status-info'},
  primary: {stamp: 'text-primary border-primary', wash: 'bg-primary'},
  muted: {stamp: 'text-muted-foreground border-muted-foreground', wash: 'bg-muted-foreground'},
}
const toneClasses = (tone: SwipeTone) => TONE_CLASSES[tone] ?? TONE_CLASSES.muted

export type UseSwipeDeckOptions = {
  count: number
  disabled?: boolean
  threshold?: number
  steps?: number
  flick?: number
  onDecide?: (index: number, choice: SwipeChoice) => void
  onUndo?: (index: number) => void
  onOpen?: (index: number) => void
}

/** The deck's state: which card is on top, what was decided, and the drag's intent toward a side. */
export function useSwipeDeck({count, threshold = 92, steps = 6, flick = 520, onDecide, onUndo, onOpen, disabled = false}: UseSwipeDeckOptions) {
  const total = Math.max(0, Math.floor(count))
  const grain = Math.max(1, Math.floor(steps))
  const reach = Math.max(1, threshold)
  const [decisions, setDecisions] = React.useState<SwipeChoice[]>([])
  const [flow, setFlow] = React.useState<SwipeDeckFlow>({dir: 1, kind: 'decide'})
  const [intent, setIntent] = React.useState<SwipeIntent>(BLANK)
  const index = Math.min(decisions.length, total)
  const len = React.useRef(decisions.length)
  len.current = decisions.length
  const size = React.useRef(total)
  size.current = total
  const made = React.useRef(decisions)
  made.current = decisions
  const handlers = React.useRef({onDecide, onUndo, onOpen})
  handlers.current = {onDecide, onUndo, onOpen}

  const clear = React.useCallback(() => setIntent(prev => (prev.step === 0 && prev.dir === 0 ? prev : BLANK)), [])
  const decide = React.useCallback((choice: SwipeChoice) => {
    if (disabled) return
    const at = len.current
    if (at >= size.current) return
    len.current = at + 1
    setDecisions(prev => [...prev, choice])
    setFlow({dir: choice === 'right' ? 1 : -1, kind: 'decide'})
    setIntent(BLANK)
    handlers.current.onDecide?.(at, choice)
  }, [disabled])
  const undo = React.useCallback(() => {
    if (disabled) return
    const at = len.current
    if (at === 0) return
    const last = made.current[at - 1]
    len.current = at - 1
    setDecisions(prev => prev.slice(0, -1))
    setFlow({dir: last === 'right' ? 1 : -1, kind: 'undo'})
    setIntent(BLANK)
    handlers.current.onUndo?.(at - 1)
  }, [disabled])
  const restart = React.useCallback(() => { len.current = 0; setDecisions([]); setIntent(BLANK); setFlow({dir: 1, kind: 'decide'}) }, [])
  const open = React.useCallback(() => { if (len.current < size.current) handlers.current.onOpen?.(len.current) }, [])
  const report = React.useCallback((dx: number) => {
    const step = Math.min(grain, Math.round((Math.abs(dx) / reach) * grain))
    const dir: -1 | 0 | 1 = step === 0 ? 0 : dx > 0 ? 1 : -1
    setIntent(prev => (prev.dir === dir && prev.step === step ? prev : {dir, step}))
  }, [grain, reach])
  const release = React.useCallback((dx: number, vx: number, dy: number) => {
    const far = Math.abs(dx) >= reach
    const fast = Math.abs(vx) >= flick && Math.abs(dx) >= reach * 0.35
    if (!far && !fast) {
      clear()
      if (dy <= -reach && Math.abs(dy) > Math.abs(dx)) open()
      return
    }
    decide((far ? dx : vx) > 0 ? 'right' : 'left')
  }, [reach, flick, clear, decide, open])
  const onKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return
    const run: Record<string, () => void> = {ArrowLeft: () => decide('left'), ArrowRight: () => decide('right'), ArrowUp: open, Enter: open, Backspace: undo, Delete: undo, Escape: clear}
    const action = run[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }, [decide, undo, clear, open])
  React.useEffect(() => {
    const bail = () => clear()
    const hidden = () => document.hidden && clear()
    window.addEventListener('blur', bail)
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('blur', bail); document.removeEventListener('visibilitychange', hidden) }
  }, [clear])
  return {
    index, count: total, remaining: total - index, done: index >= total, decisions, flow, intent, steps: grain,
    canUndo: decisions.length > 0, decide, undo, restart, open, clear, report, release,
    deckProps: {role: 'group' as const, 'aria-roledescription': 'card deck', tabIndex: 0, onKeyDown},
  }
}

type DeckCardProps = {
  depth: number
  entryX: number
  active: boolean
  disabled: boolean
  reduced: boolean
  label: string
  leftLabel: string
  rightLabel: string
  leftTone: SwipeTone
  rightTone: SwipeTone
  intent: SwipeIntent
  steps: number
  onMove: (dx: number) => void
  onRelease: (dx: number, vx: number, dy: number) => void
  onPress: () => void
  children: React.ReactNode
}

function DeckCard({depth, entryX, active, disabled, reduced, label, leftLabel, rightLabel, leftTone, rightTone, intent, steps, onMove, onRelease, onPress, children}: DeckCardProps) {
  const x = useMotionValue(entryX)
  const rotate = useTransform(x, [-200, 0, 200], [-10, 0, 10], {clamp: false})
  const fade = useTransform(x, [-340, -150, 0, 150, 340], [0, 1, 1, 1, 0])
  const dragged = React.useRef(false)
  const skip = React.useRef(reduced)
  skip.current = reduced
  React.useEffect(() => {
    if (x.get() === 0) return
    const controls = animate(x, 0, skip.current ? {duration: 0} : DISCLOSE)
    return () => controls.stop()
  }, [x, entryX])
  const commit = active ? 0 : depth === 1 ? intent.step / steps : 0
  const y = depth * PEEK_STEP - commit * PEEK_STEP
  const scale = 1 - depth * PEEK_SHRINK + commit * PEEK_SHRINK
  // The side the top card leans toward shows itself the way a stamped card does: its word, tilted, in its colour, and
  // a wash of that colour over the card that deepens as the drag nears the point where letting go decides it.
  const badge = (side: -1 | 1, text: string, tone: SwipeTone) => {
    const on = intent.dir === side
    const colour = toneClasses(tone)
    return (
      <React.Fragment key={side}>
        <motion.span aria-hidden initial={false} data-swipe-wash={side < 0 ? 'left' : 'right'}
          animate={{opacity: on ? (intent.step / steps) * 0.16 : 0}} transition={reduced ? {duration: 0} : CELL}
          className={`pointer-events-none absolute inset-0 z-10 rounded-2xl ${colour.wash}`}/>
        <motion.span aria-hidden initial={false} data-swipe-side={side < 0 ? 'left' : 'right'} data-armed={on && intent.step >= steps ? 'true' : undefined}
          animate={{opacity: on ? intent.step / steps : 0, scale: on ? 1 : 0.9}} transition={reduced ? {duration: 0} : CELL}
          style={{rotate: side < 0 ? 12 : -12}}
          className={`pointer-events-none absolute top-5 z-20 whitespace-nowrap rounded-lg border-2 bg-popover px-3 py-1 text-base font-bold shadow-sm ${colour.stamp} ${side < 0 ? 'right-5' : 'left-5'}`}>
          {text}
        </motion.span>
      </React.Fragment>
    )
  }
  return (
    <motion.div
      role="group" aria-label={label} aria-hidden={!active} inert={!active || undefined}
      data-swipe-card="" data-depth={depth}
      variants={{exit: (dir: number) => ({x: dir * 560, zIndex: 12, transition: reduced ? {duration: 0} : {x: {duration: 0.3, ease: LEAVE}}})}}
      initial={{y, scale}} animate={{y, scale}} exit="exit"
      transition={reduced ? {duration: 0} : active ? {...CROSSFADE, delay: 0.1} : CROSSFADE}
      drag={active && !disabled} dragMomentum={false} dragElastic={1}
      dragConstraints={{left: 0, right: 0, top: 0, bottom: 0}} dragTransition={{bounceStiffness: 260, bounceDamping: 34}}
      whileDrag={reduced ? undefined : {scale: 1.03}}
      onDragStart={() => { dragged.current = true }}
      onDrag={(_event, info) => onMove(info.offset.x)}
      onDragEnd={(_event, info) => { onRelease(info.offset.x, info.velocity.x, info.offset.y); setTimeout(() => { dragged.current = false }, 0) }}
      onClickCapture={event => { if (dragged.current) { event.stopPropagation(); event.preventDefault() } }}
      onClick={() => { if (!dragged.current && active) onPress() }}
      style={{x, rotate, opacity: fade, zIndex: 10 - depth, transformOrigin: '50% 100%', touchAction: 'none'}}
      className={`absolute inset-x-0 top-0 select-none rounded-2xl ${active ? 'cursor-grab shadow-lg active:cursor-grabbing' : 'shadow-md'}`}
    >
      {children}
      {active ? null : <span aria-hidden data-swipe-under="" style={{opacity: Math.min(0.5, depth * 0.18)}} className="pointer-events-none absolute inset-0 z-10 rounded-2xl bg-background"/>}
      {active ? badge(-1, leftLabel, leftTone) : null}
      {active ? badge(1, rightLabel, rightTone) : null}
    </motion.div>
  )
}

export type SwipeDeckProps<T> = {
  items: readonly T[]
  itemKey: (item: T) => string
  itemLabel: (item: T) => string
  children: (item: T) => React.ReactNode
  onDecide?: (item: T, choice: SwipeChoice) => void
  onUndo?: (item: T) => void
  onOpen?: (item: T) => void
  onRestart?: () => void
  disabled?: boolean
  label?: string
  leftLabel?: string
  rightLabel?: string
  leftIcon?: string
  rightIcon?: string
  /** The look's colour each side shows while the top card leans toward it. */
  leftTone?: SwipeTone
  rightTone?: SwipeTone
  undoLabel?: string
  emptyLabel?: string
  againLabel?: string
  /** The cards' height; the deck adds room for the peeking cards under it. */
  height?: number
  threshold?: number
  steps?: number
  peek?: number
}

export function SwipeDeck<T>({
  items, itemKey, itemLabel, children, onDecide, onUndo, onOpen, onRestart, disabled = false, label = 'Card deck', leftLabel = 'Skip', rightLabel = 'Keep',
  leftIcon = 'X', rightIcon = 'Check', leftTone = 'destructive', rightTone = 'success', undoLabel = 'Undo', emptyLabel = 'You have seen them all', againLabel = 'Start again',
  height = 380, threshold = 92, steps = 6, peek = 3,
}: SwipeDeckProps<T>) {
  const hintId = React.useId()
  const reduced = useReducedMotion() === true
  const deck = useSwipeDeck({
    count: items.length, threshold, steps, disabled,
    onDecide: (at, choice) => { const item = items[at]; if (item !== undefined) onDecide?.(item, choice) },
    onUndo: at => { const item = items[at]; if (item !== undefined) onUndo?.(item) },
    onOpen: at => { const item = items[at]; if (item !== undefined) onOpen?.(item) },
  })
  const stack = items.slice(deck.index, deck.index + Math.max(1, peek))
  const current = items[deck.index]
  return (
    <div className="flex w-full flex-col gap-3" data-swipe-deck="">
      <div aria-label={label} aria-describedby={hintId} style={{height: height + Math.max(0, Math.min(peek, items.length) - 1) * PEEK_STEP + 8}}
        className="relative w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        {...deck.deckProps}>
        <motion.div aria-hidden={!deck.done} initial={false} animate={{opacity: deck.done ? 1 : 0}} transition={reduced ? {duration: 0} : CROSSFADE}
          style={{height}} className="absolute inset-x-0 top-0 z-0 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-muted/40 px-4 text-center text-sm text-muted-foreground">
          <NamedIcon name="CircleCheck" size="md" aria-hidden/>
          <span>{emptyLabel}</span>
          {deck.done && items.length > 0 ? <Button type="button" size="sm" variant="outline" onClick={() => { deck.restart(); onRestart?.() }}>{againLabel}</Button> : null}
        </motion.div>
        <AnimatePresence initial={false} custom={deck.flow.dir}>
          {stack.map((item, depth) => (
            <DeckCard key={itemKey(item)} depth={depth} entryX={depth === 0 && deck.flow.kind === 'undo' ? deck.flow.dir * 560 : 0}
              active={depth === 0} disabled={disabled} reduced={reduced} label={itemLabel(item)} leftLabel={leftLabel} rightLabel={rightLabel} leftTone={leftTone} rightTone={rightTone}
              intent={deck.intent} steps={deck.steps} onMove={deck.report} onRelease={deck.release} onPress={deck.open}>
              <div style={{height}} className="overflow-hidden rounded-2xl">{children(item)}</div>
            </DeckCard>
          ))}
        </AnimatePresence>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Button type="button" size="sm" variant="outline" className="justify-self-start" disabled={deck.done || disabled} onClick={() => deck.decide('left')}>
          <NamedIcon name={leftIcon} size="sm" aria-hidden/>{leftLabel}
        </Button>
        <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {/* Where the top card is, the way the spoken line says it (card 1 of 9), never how many are left. */}
          <span aria-hidden>{Math.min(deck.index + 1, items.length)} of {items.length}</span>
          <Button type="button" size="xs" variant="ghost" disabled={!deck.canUndo || disabled} onClick={deck.undo}>
            <NamedIcon name="Undo2" size="xs" aria-hidden/>{undoLabel}
          </Button>
        </span>
        <Button type="button" size="sm" variant="outline" className="justify-self-end" disabled={deck.done || disabled} onClick={() => deck.decide('right')}>
          {rightLabel}<NamedIcon name={rightIcon} size="sm" aria-hidden/>
        </Button>
      </div>
      <p aria-live="polite" aria-atomic className="sr-only">
        {deck.done || current === undefined ? emptyLabel : `${itemLabel(current)}. Card ${deck.index + 1} of ${items.length}.`}
      </p>
      <span id={hintId} className="sr-only">Left and right arrow keys decide the top card, up or Enter opens it, and Backspace brings the last one back.</span>
    </div>
  )
}
