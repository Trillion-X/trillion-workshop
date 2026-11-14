// packages/ui/show/card-layouts/CardLayouts.test.tsx
//
// The layouts are DATA: a layout nobody wrote code for draws from its row
// alone, sections hide when they hold nothing, ungrouped layouts show each card
// once, the shuffle is stable per seed, and a section's View all shows it whole.
import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {CardLayouts, cardsFor, shuffleKey, type CardLayoutsOptions, type LayoutCard} from './CardLayouts'

afterEach(cleanup)

const cards: LayoutCard[] = [
  {id: 'soup', title: 'Tomato soup', groups: ['quick', 'saved']},
  {id: 'salad', title: 'Green salad', groups: ['quick']},
  {id: 'bread', title: 'Sourdough', detail: '2 days', groups: ['slow']},
  {id: 'stew', title: 'Beef stew', groups: ['slow'], actions: [{id: 'cook', label: 'Cook this', icon: 'Flame', lead: true}, {id: 'keep', label: 'Keep', icon: 'Bookmark'}]},
]
const options = (over: Partial<CardLayoutsOptions> = {}): CardLayoutsOptions => ({
  cards,
  sections: [{id: 'quick', title: 'Quick dinners', subtitle: 'Under twenty minutes'}, {id: 'saved', title: 'Kept'}, {id: 'slow', title: 'Weekend cooking'}, {id: 'nothing', title: 'Never drawn'}],
  layouts: [
    {id: 'shelves', label: 'Shelves', icon: 'Rows3', grouped: true, shuffle: false, flow: 'row'},
    {id: 'pile', label: 'Pile', icon: 'LayoutDashboard', grouped: false, shuffle: true, flow: 'wall'},
    {id: 'even', label: 'Even', icon: 'LayoutGrid', grouped: false, shuffle: false, flow: 'grid'},
  ],
  layout: 'shelves',
  seed: '2026-09-27',
  label: 'Recipes',
  empty: {title: 'No recipes yet'},
  onLayout: vi.fn(), onFocus: vi.fn(), onOpen: vi.fn(), onCardAction: vi.fn(),
  ...over,
})

describe('CardLayouts', () => {
  it('draws each section that holds cards, with its title and subtitle, and hides empty ones', () => {
    render(<CardLayouts {...options()}/>)
    expect(screen.getByRole('region', {name: 'Quick dinners'})).toBeTruthy()
    expect(screen.getByText('Under twenty minutes')).toBeTruthy()
    expect(screen.queryByRole('region', {name: 'Never drawn'})).toBeNull()
    expect(within(screen.getByRole('list', {name: 'Quick dinners'})).getAllByRole('listitem')).toHaveLength(2)
    expect(document.querySelector('.card-layouts-cards')!.getAttribute('data-flow')).toBe('row')
  })

  it('draws a layout from its DATA row alone: ungrouped, each card once, in the row\'s flow', () => {
    render(<CardLayouts {...options({layout: 'even'})}/>)
    const list = screen.getByRole('list', {name: 'Recipes'})
    expect(list.getAttribute('data-flow')).toBe('grid')
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByRole('heading', {name: /Quick dinners/})).toBeNull()
  })

  it('shuffles by seed: the same seed keeps the order, and every card stays', () => {
    const first = cardsFor(cards, null, true, 'monday').map(card => card.id)
    expect(cardsFor(cards, null, true, 'monday').map(card => card.id)).toEqual(first)
    expect([...first].sort()).toEqual(['bread', 'salad', 'soup', 'stew'])
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f'].map(seed => cardsFor(cards, null, true, seed).map(card => card.id).join())
    expect(new Set(seeds).size).toBeGreaterThan(1)
    expect(shuffleKey('x', 'y')).toBe(shuffleKey('x', 'y'))
  })

  it('switches layouts through the shared choice control', () => {
    const onLayout = vi.fn()
    render(<CardLayouts {...options({onLayout})}/>)
    fireEvent.click(screen.getByRole('radio', {name: 'Pile'}))
    expect(onLayout).toHaveBeenCalledWith('pile')
  })

  it('shows one section whole in the focus layout, with a way back', () => {
    const onFocus = vi.fn()
    render(<CardLayouts {...options({focus: 'slow', focusLayout: 'even', onFocus})}/>)
    expect(screen.getByRole('list', {name: 'Weekend cooking'}).getAttribute('data-flow')).toBe('grid')
    expect(screen.queryByRole('region', {name: 'Quick dinners'})).toBeNull()
    fireEvent.click(screen.getByRole('button', {name: /Back/}))
    expect(onFocus).toHaveBeenCalledWith(null)
  })

  it('says a section is reading, and when a read failed offers to try again', () => {
    const onRetry = vi.fn()
    render(<CardLayouts {...options({sections: [{id: 'later', title: 'Coming', pending: true}, {id: 'broken', title: 'Broken', error: 'Could not load this row.'}], onRetry})}/>)
    expect(screen.getByRole('status', {name: 'Loading Coming'})).toBeTruthy()
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', {name: 'Try again'}))
    expect(onRetry).toHaveBeenCalledWith('broken')
  })

  it('opens a card by pressing its picture', () => {
    const onOpen = vi.fn()
    render(<CardLayouts {...options({onOpen})}/>)
    fireEvent.click(screen.getAllByRole('button', {name: 'Sourdough'})[0]!)
    expect(onOpen).toHaveBeenCalledWith('bread')
  })

  it('shows the empty message when there are no cards and nothing is reading', () => {
    render(<CardLayouts {...options({cards: [], empty: {title: 'No recipes yet', description: 'Add one to start.'}})}/>)
    expect(screen.getByRole('status').textContent).toContain('No recipes yet')
  })

  it('gives a card the shape of its image once the image loads', () => {
    render(<CardLayouts {...options({cards: [{id: 'tall', title: 'Tall', groups: ['quick'], picture: <img alt=""/>}]})}/>)
    const image = document.querySelector('.card-layouts-picture img') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', {value: 900})
    Object.defineProperty(image, 'naturalHeight', {value: 1600})
    fireEvent.load(image)
    expect((document.querySelector('.card-layouts-picture') as HTMLElement).style.getPropertyValue('--card-aspect')).toBe(String(900 / 1600))
  })
})
