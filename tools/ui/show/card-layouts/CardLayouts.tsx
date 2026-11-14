// packages/ui/show/card-layouts/CardLayouts.tsx
//
// PURPOSE
//   One set of cards drawn in a layout chosen by DATA. A layout row says three
//   things: whether cards are shown under their section headings, whether their
//   order is shuffled (by a seed the caller gives, so the order holds for as
//   long as the caller keeps that seed), and which flow draws them. The flow is
//   only a name; screen-look/show/card-layouts.css decides what each name looks
//   like (a sideways row, a column-balanced wall, a grid). Adding a layout is one
//   more row from the caller; adding a flow is one more CSS rule.
//
//   Anatomy: sections after the 21st.dev home page (a bold title with its
//   count, one quiet line under it, View all at the right, then a sideways row
//   of large rounded pictures with the name under each), the wall after
//   Pinterest's home feed (column-balanced cards that keep their picture's own
//   shape). Hovering a card opens the shared hover card (Base UI PreviewCard,
//   the same one record-views uses): whatever the caller mounts into it (a
//   player), the name, the card's lead action as a button and the others in
//   the shared ExpandableTabs action group.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind. This part never names a kind of card, a section or a layout.
//      Words, pictures, sections, layouts and actions are caller DATA; what an
//      action does is the caller's `onCardAction`.
//   2. A card belongs to sections by id (`groups`). A section with no cards and
//      nothing pending is not drawn; a section still reading says so; a
//      section whose read failed says so with Try again.
//   3. Ungrouped layouts show each card once, however many sections hold it.
//   4. The shuffle is a pure function of (seed, card id): the same seed always
//      gives the same order, a new seed a new one.
//   5. A picture keeps its own shape in flows that allow it: when an image
//      inside a card loads, the card's aspect becomes the image's own.
//   6. Appearance lives only in screen-look/show/card-layouts.css.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React, {useEffect, useRef} from 'react'
import {PreviewCard} from '@base-ui/react/preview-card'
import {Button} from '../coss/ui/button'
import {ExpandableTabs, type ExpandableTabItem} from '../expandable-tabs/ExpandableTabs'
import {NamedIcon} from '../icon'
import {LAYER_ORDER} from '../layer-order/layer-order'
import {safeEdgePadding} from '../visible-viewport/safe-area-insets'
import {watchScrollFade} from '../scrollable-surface/scroll-fade'
import {CARD_CONTROLS, cardShown} from '../hover-preview/card-shown'
import {useShowChange} from '../show-rules/show-of'

/** One thing a card or a section header can do. `lead` draws it as a labeled
 *  button; the others share one action group. `pinned` keeps an action's
 *  name open (a state that is on, such as Saved). */
export type CardAction = {id: string; label: string; icon: string; lead?: boolean; pinned?: boolean; disabled?: boolean}

export type LayoutCard = {
  id: string
  title: string
  /** One quiet line under the name (a kind, a date, a length). */
  detail?: string
  /** A longer passage shown only in the hover card (what is said, what is written). */
  summary?: string
  /** The picture, as an element the caller builds (a shared MediaPreview). */
  picture?: React.ReactNode
  /** The picture box's starting width / height; an image that loads replaces it. */
  aspect?: number
  /** Section ids this card belongs to. */
  groups: string[]
  actions?: CardAction[]
}

export type CardSection = {
  id: string
  title: string
  subtitle?: string
  /** How many exist in total, when more exist than are shown. */
  total?: number
  actions?: CardAction[]
  /** Still reading, or the words saying why the read failed. */
  pending?: boolean
  error?: string
}

export type CardLayout = {
  id: string
  label: string
  icon: string
  /** Cards under their section headings, or one run of every card. */
  grouped: boolean
  /** Order by the caller's seed instead of as given. */
  shuffle: boolean
  /** The flow name screen-look draws (a row, a wall, a grid). */
  flow: string
}

export type CardLayoutsOptions = {
  cards: LayoutCard[]
  sections: CardSection[]
  layouts: CardLayout[]
  layout: string
  /** The one section being viewed whole (View all), drawn in `focusLayout`. */
  focus?: string | null
  focusLayout?: string
  seed: string
  label: string
  empty: {title: string; description?: string}
  viewAllLabel?: string
  backLabel?: string
  onLayout: (id: string) => void
  onFocus: (sectionId: string | null) => void
  onOpen: (cardId: string) => void
  onCardAction: (cardId: string, actionId: string) => void
  onSectionAction?: (sectionId: string, actionId: string) => void
  onRetry?: (sectionId: string) => void
  /** Mount something into a card's hover card (a player); return its release. */
  onPreview?: (cardId: string, host: HTMLElement) => (() => void) | void
}

/** FNV-1a over the seed and the id: a stable, well-spread sort key. */
export function shuffleKey(seed: string, id: string): number {
  let hash = 0x811c9dc5
  for (const character of seed + '\u0000' + id) {
    hash ^= character.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** The cards one block shows: a section's own, or all of them once each. */
export function cardsFor(cards: LayoutCard[], sectionId: string | null, shuffle: boolean, seed: string): LayoutCard[] {
  const seen = new Set<string>()
  const chosen = cards.filter(card => (sectionId === null || card.groups.includes(sectionId)) && !seen.has(card.id) && !!seen.add(card.id))
  return shuffle ? chosen.map(card => ({card, key: shuffleKey(seed, card.id)})).sort((a, b) => a.key - b.key).map(entry => entry.card) : chosen
}

function Picture({card, onOpen}: {card: LayoutCard; onOpen: () => void}) {
  const box = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const node = box.current
    if (!node) return
    // A loaded image gives the card its own shape; load does not bubble, so
    // the listener captures it on the way down.
    const shape = (event: Event) => {
      const image = event.target
      if (image instanceof HTMLImageElement && image.naturalWidth && image.naturalHeight) node.style.setProperty('--card-aspect', String(image.naturalWidth / image.naturalHeight))
    }
    node.addEventListener('load', shape, true)
    return () => node.removeEventListener('load', shape, true)
  }, [])
  return (
    <button ref={box} type="button" className="card-layouts-picture" aria-label={card.title} onClick={onOpen} style={card.aspect ? {['--card-aspect' as string]: String(card.aspect)} : undefined}>
      {card.picture}
    </button>
  )
}

function Preview({cardId, onPreview}: {cardId: string; onPreview: NonNullable<CardLayoutsOptions['onPreview']>}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { if (host.current) return onPreview(cardId, host.current) || undefined }, [cardId, onPreview])
  return <div ref={host} className="card-layouts-hover-media"/>
}

function Actions({actions, label, onAction}: {actions: CardAction[]; label: string; onAction: (id: string) => void}) {
  const lead = actions.filter(action => action.lead)
  const rest = actions.filter(action => !action.lead)
  return (
    <div className="card-layouts-actions">
      {lead.map(action => (
        <Button key={action.id} size="sm" disabled={action.disabled} onClick={() => onAction(action.id)}>
          <NamedIcon name={action.icon} aria-hidden="true"/>{action.label}
        </Button>
      ))}
      {rest.length > 0 && (
        <ExpandableTabs mode="action" size="sm" ariaLabel={label} onSelect={onAction}
          items={rest.map((action): ExpandableTabItem => ({id: action.id, label: action.label, icon: action.icon, pinned: action.pinned, disabled: action.disabled}))}/>
      )}
    </div>
  )
}

function Card({card, options}: {card: LayoutCard; options: CardLayoutsOptions}) {
  const actions = card.actions ?? []
  const trigger = (
    <article className="card-layouts-card" data-card-id={card.id}>
      <Picture card={card} onOpen={() => options.onOpen(card.id)}/>
      <div className="card-layouts-meta">
        <span className="card-layouts-title">{card.title}</span>
        {card.detail && <span className="card-layouts-detail">{card.detail}</span>}
      </div>
    </article>
  )
  if ((!actions.length && !options.onPreview) || !cardShown(CARD_CONTROLS.list)) return trigger
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={trigger} delay={450} closeDelay={140}/>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" align="center" sideOffset={-48} collisionPadding={safeEdgePadding(12)} style={{zIndex: LAYER_ORDER.menu}}>
          <PreviewCard.Popup className="coss-ui card-layouts-hover" data-slot="card-layouts-hover">
            {options.onPreview && <Preview cardId={card.id} onPreview={options.onPreview}/>}
            <div className="card-layouts-hover-body">
              <strong className="card-layouts-hover-title">{card.title}</strong>
              {card.detail && <span className="card-layouts-detail">{card.detail}</span>}
              {card.summary && <p className="card-layouts-summary">{card.summary}</p>}
            </div>
            {actions.length > 0 && <Actions actions={actions} label={`Actions for ${card.title}`} onAction={id => options.onCardAction(card.id, id)}/>}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}

/** A flow that scrolls sideways gets its edges faded and a step button at
 *  each end; every other flow scrolls with the page. */
function Cards({cards, flow, options, label}: {cards: LayoutCard[]; flow: string; options: CardLayoutsOptions; label: string}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current) return watchScrollFade(list.current, ['left', 'right']) }, [])
  const step = (direction: number) => { const node = list.current; if (node) node.scrollBy({left: direction * node.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}) }
  return (
    <div className="card-layouts-cards-frame" data-flow={flow}>
      <div className="card-layouts-step" data-edge="start"><Button variant="outline" size="icon" aria-label={`Scroll ${label} back`} onClick={() => step(-1)}><NamedIcon name="ChevronLeft" aria-hidden="true"/></Button></div>
      <div ref={list} className="card-layouts-cards" data-flow={flow} role="list" aria-label={label}>
        {cards.map(card => <div key={card.id} role="listitem" className="card-layouts-item"><Card card={card} options={options}/></div>)}
      </div>
      <div className="card-layouts-step" data-edge="end"><Button variant="outline" size="icon" aria-label={`Scroll ${label} forward`} onClick={() => step(1)}><NamedIcon name="ChevronRight" aria-hidden="true"/></Button></div>
    </div>
  )
}

function SectionHeader({section, count, options, focused}: {section: CardSection; count: number; options: CardLayoutsOptions; focused: boolean}) {
  const total = section.total ?? count
  return (
    <header className="card-layouts-section-header">
      <div className="card-layouts-heading">
        <h2 className="card-layouts-section-title">{section.title}{total > 0 && <span className="card-layouts-count">{total.toLocaleString()}</span>}</h2>
        {section.subtitle && <p className="card-layouts-subtitle">{section.subtitle}</p>}
      </div>
      <div className="card-layouts-section-tools">
        {(section.actions ?? []).length > 0 && <Actions actions={section.actions!} label={`Actions for ${section.title}`} onAction={id => options.onSectionAction?.(section.id, id)}/>}
        {focused
          ? <Button variant="ghost" size="sm" onClick={() => options.onFocus(null)}><NamedIcon name="ArrowLeft" aria-hidden="true"/>{options.backLabel ?? 'Back'}</Button>
          : total > count || count > 4 ? <Button variant="ghost" size="sm" onClick={() => options.onFocus(section.id)}>{options.viewAllLabel ?? 'View all'}<NamedIcon name="ChevronRight" aria-hidden="true"/></Button> : null}
      </div>
    </header>
  )
}

function Section({section, cards, flow, options, focused}: {section: CardSection; cards: LayoutCard[]; flow: string; options: CardLayoutsOptions; focused: boolean}) {
  if (!cards.length && !section.pending && !section.error) return null
  return (
    <section className="card-layouts-section" data-section-id={section.id} aria-label={section.title}>
      <SectionHeader section={section} count={cards.length} options={options} focused={focused}/>
      {section.error && !cards.length
        ? <p className="card-layouts-note" role="alert">{section.error} {options.onRetry && <Button variant="ghost" size="sm" onClick={() => options.onRetry!(section.id)}>Try again</Button>}</p>
        : !cards.length ? <div className="card-layouts-pending" role="status" aria-label={`Loading ${section.title}`}/>
        : <Cards cards={cards} flow={flow} options={options} label={section.title}/>}
    </section>
  )
}

export function CardLayouts(options: CardLayoutsOptions) {
  // Each card's hover card is the lists' card control (../hover-preview/card-shown.ts): drawn again when rules change.
  useShowChange()
  const layout = options.layouts.find(row => row.id === options.layout) ?? options.layouts[0]
  const focusSection = options.focus ? options.sections.find(section => section.id === options.focus) : undefined
  const focusLayout = options.layouts.find(row => row.id === options.focusLayout) ?? layout
  const anything = options.cards.length > 0 || options.sections.some(section => section.pending)
  const switcher = options.layouts.length > 1 && !focusSection && (
    <ExpandableTabs mode="choice" size="sm" ariaLabel="Layout" value={layout?.id}
      items={options.layouts.map(row => ({id: row.id, label: row.label, icon: row.icon}))} onChange={options.onLayout}/>
  )
  let body: React.ReactNode
  if (!layout) body = null
  else if (focusSection) body = <Section section={focusSection} cards={cardsFor(options.cards, focusSection.id, focusLayout!.shuffle, options.seed)} flow={focusLayout!.flow} options={options} focused/>
  else if (!anything) body = <div className="card-layouts-empty" role="status"><strong>{options.empty.title}</strong>{options.empty.description && <p>{options.empty.description}</p>}</div>
  else if (layout.grouped) body = options.sections.map(section => <Section key={section.id} section={section} cards={cardsFor(options.cards, section.id, layout.shuffle, options.seed)} flow={layout.flow} options={options} focused={false}/>)
  else body = <Cards cards={cardsFor(options.cards, null, layout.shuffle, options.seed)} flow={layout.flow} options={options} label={options.label}/>
  return (
    <div className="card-layouts" data-layout={layout?.id} aria-label={options.label}>
      {switcher && <div className="card-layouts-bar">{switcher}</div>}
      {body}
    </div>
  )
}
