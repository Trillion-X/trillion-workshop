/** @vitest-environment jsdom */
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FactChips, formatFactValue, type FactField } from '@/packages/ui/show/fact-chips'

afterEach(() => cleanup())

const FIELDS: FactField[] = [
  { id: 'labels', label: 'Tags', kind: 'tags', icon: 'tags', chip: { order: 3, edit: 'tags' } },
  { id: 'duration', label: 'Length', kind: 'duration', icon: 'timer', chip: { order: 2, details: ['size'] } },
  { id: 'project', label: 'Project', kind: 'tags', icon: 'folder-tree', chip: { order: 1, actions: [{ id: 'organize', label: 'Add to project…' }] } },
  { id: 'language', label: 'Language', kind: 'choice', values: { en: { label: 'English' } }, chip: { order: 4 } },
  { id: 'size', label: 'File size', kind: 'bytes', icon: 'hard-drive' },
]

describe('FactChips', () => {
  it('orders chips by their DATA, formats by kind and hides empty facts', () => {
    render(<FactChips fields={FIELDS} facts={{ duration: 365.4, project: ['p1', 'p2'], size: 4_600_000_000 }} valueLabels={{ p1: 'Pottery', p2: 'Lakeside Pottery' }} />)
    const chips = [...document.querySelectorAll('[data-fact-chip]')].map(chip => chip.getAttribute('data-fact-chip'))
    expect(chips).toEqual(['project', 'duration', 'labels'])
    expect(screen.getByLabelText('Project: Pottery, Lakeside Pottery').textContent).toBe('Pottery +1')
    expect(screen.getByLabelText('Length: 6:05').textContent).toBe('6:05')
  })

  it('formats every kind from field DATA', () => {
    expect(formatFactValue(FIELDS[1], 3725)).toBe('1:02:05')
    expect(formatFactValue(FIELDS[3], 'en')).toBe('English')
    expect(formatFactValue(FIELDS[4], 4_600_000_000)).toBe('4.6 GB')
    expect(formatFactValue({ id: 'w', label: 'Words', kind: 'number', unit: 'words' }, 1234)).toBe('1,234 words')
    expect(formatFactValue({ id: 'p', label: 'Project', kind: 'tags' }, 'undefined')).toBe('')
    expect(formatFactValue({ id: 'p', label: 'Project', kind: 'tags' }, ['undefined', 'null', 'p1'], { p1: 'Pottery' })).toBe('Pottery')
  })

  it('reports actions and tag edits to the caller', async () => {
    const onAction = vi.fn()
    render(<FactChips fields={FIELDS} facts={{ labels: ['drill'], project: ['p1'] }} valueLabels={{ p1: 'Pottery' }} onAction={onAction} />)
    fireEvent.click(screen.getByLabelText('Tags: drill'))
    fireEvent.click(await screen.findByLabelText('Remove drill'))
    expect(onAction).toHaveBeenCalledWith('remove', 'labels', 'drill')
    const input = screen.getByPlaceholderText('Add tags')
    fireEvent.change(input, { target: { value: 'serve' } })
    fireEvent.submit(input.closest('form')!)
    expect(onAction).toHaveBeenCalledWith('add', 'labels', 'serve')
    fireEvent.click(screen.getByLabelText('Project: Pottery'))
    fireEvent.click(await screen.findByText('Add to project…'))
    expect(onAction).toHaveBeenCalledWith('organize', 'project')
  })

  it('does not render placeholder strings as facts and keeps detail icons beside labels', async () => {
    render(<FactChips fields={FIELDS} facts={{ project: ['undefined'], duration: 10, size: 1000 }} />)
    expect(screen.getByLabelText('Project: Project').textContent).toContain('Project')
    expect(screen.getByLabelText('Project: Project').textContent).not.toContain('undefined')
    fireEvent.click(screen.getByLabelText('Length: 0:10'))
    expect(await screen.findByText('File size')).toBeTruthy()
    const detailLabel = screen.getByText('File size').closest('dt')
    expect(detailLabel?.querySelector('svg')).toBeTruthy()
  })

  it('shows each location with its own DATA icon', async () => {
    render(<FactChips fields={[{id: 'places', label: 'Where it lives', kind: 'tags', icon: 'map-pin', chip: {order: 1}}]}
      facts={{places: ['Camera SSD', 'Cloud']}} valueIcons={{'Camera SSD': 'hard-drive', Cloud: 'cloud'}} />)
    fireEvent.click(screen.getByLabelText('Where it lives: Camera SSD, Cloud'))
    const list = (await screen.findByText('Cloud')).closest('ul')
    expect(list?.querySelectorAll('li svg')).toHaveLength(2)
  })

  // "Add to project…" opens the project and folder choices instead of leaving
  // the card; a folder that holds folders nests again, and the chosen one
  // reaches the caller as the action's value.
  it('opens nested choices behind an action and reports the chosen one', async () => {
    const onAction = vi.fn()
    const choicesFor = (actionId: string) => actionId === 'organize'
      ? [{ id: 'channel', label: 'Channel', icon: 'folder', items: [{ id: 'channel', label: 'Put in Channel', icon: 'folder' }, { id: 'series', label: 'Series', icon: 'clapperboard' }] }]
      : null
    render(<FactChips fields={FIELDS} facts={{ project: ['p1'] }} valueLabels={{ p1: 'Pottery' }} onAction={onAction} choicesFor={choicesFor} />)
    fireEvent.click(screen.getByLabelText('Project: Pottery'))
    fireEvent.click(await screen.findByRole('button', { name: 'Add to project…' }))
    const row = (label: string) => [...document.querySelectorAll('[data-action-id]')].find(node => node.textContent?.includes(label)) as HTMLElement
    await vi.waitFor(() => expect(row('Channel')).toBeTruthy())
    fireEvent.click(row('Channel'))
    await vi.waitFor(() => expect(row('Series')).toBeTruthy())
    fireEvent.click(row('Series'))
    expect(onAction).toHaveBeenCalledWith('organize', 'project', 'series')
  })
})
