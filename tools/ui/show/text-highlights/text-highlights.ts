// parts/ui/show/text-highlights/text-highlights.ts
//
// Purpose
//   Marks words on a surface (found words, the words an answer cites, a reviewer's marks) as CSS Custom Highlights: ranges
//   over the surface's own text nodes registered in CSS.highlights, so no element is added, wrapped or re-rendered. A
//   shared component's markup and collaborative text stay exactly as their owner drew them.
//
// Non-negotiable invariants
//   1. Nothing is written into the surface: no <mark>, no attribute, no class. Marks live only in CSS.highlights.
//   2. Where the browser has no Custom Highlights the text stays plain and nothing else changes; the answer still says
//      how many were found (`painted: false`).
//   3. Kinds, the words too short to look for, the most marks and the elements never marked are DATA
//      (text-highlights.json); a kind it does not name is refused.
//   4. Following a surface (`followHighlights`) repaints at most once per animation frame after it changes, and stops
//      clean (its marks removed, its observer disconnected).

import settings from './text-highlights.json' with { type: 'json' }
import '../../../screen-look/show/text-highlights.css'

type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void }
type HighlightConstructor = new (...ranges: Range[]) => unknown
export type HighlightKind = keyof typeof settings.kinds
export type Painted = { painted: boolean; count: number }

const registry = (): HighlightRegistry | null => (typeof CSS !== 'undefined' && (CSS as unknown as { highlights?: HighlightRegistry }).highlights) || null
const highlightType = (): HighlightConstructor | null => (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight ?? null
const nameOf = (kind: HighlightKind): string => {
  const row = settings.kinds[kind]
  if (!row) throw new Error(`There is no text mark called ${String(kind)}.`)
  return row.highlight
}

/** The words worth looking for in what a person typed: distinct, lowercased, at least `least_word_chars` long. */
export const wordsToFind = (typed: string): string[] => [...new Set(typed.toLocaleLowerCase().split(/\s+/).filter(word => word.length >= settings.least_word_chars))]

/** The ranges of every place `words` appear in the text under `root` (lowercase compare), at most `most_ranges`. */
export function rangesOf(root: Node, words: readonly string[]): Range[] {
  if (!words.length) return []
  const skip = settings.skip.join(',')
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: node => ((node.parentElement?.closest(skip) ?? null) || !node.nodeValue?.trim() ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */),
  })
  const ranges: Range[] = []
  for (let node = walker.nextNode(); node && ranges.length < settings.most_ranges; node = walker.nextNode()) {
    const text = node.nodeValue!.toLocaleLowerCase()
    for (const word of words) {
      for (let at = text.indexOf(word); at >= 0 && ranges.length < settings.most_ranges; at = text.indexOf(word, at + word.length)) {
        const range = root.ownerDocument!.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + word.length)
        ranges.push(range)
      }
    }
  }
  return ranges
}

/** Paints `ranges` as the marks of `kind`, replacing that kind's earlier marks (invariants 1 and 2). */
export function paintRanges(kind: HighlightKind, ranges: Range[]): Painted {
  const name = nameOf(kind)
  const highlights = registry(), Highlight = highlightType()
  if (!highlights || !Highlight) return { painted: false, count: ranges.length }
  if (ranges.length) highlights.set(name, new Highlight(...ranges)); else highlights.delete(name)
  return { painted: true, count: ranges.length }
}

/** Marks every place `words` appear under `root` as `kind`. */
export const paintWords = (root: Node, kind: HighlightKind, words: readonly string[]): Painted => paintRanges(kind, rangesOf(root, words))

/** Removes every mark of `kind`. */
export function clearHighlights(kind: HighlightKind): void { registry()?.delete(nameOf(kind)) }

/** Keeps `kind` marking the current words under `root` as the surface redraws; `set(words)` changes the words, `stop()`
 *  removes the marks and stops following (invariant 4). */
export function followHighlights(root: HTMLElement, kind: HighlightKind, onPaint: (painted: Painted) => void = () => {}): { set: (words: readonly string[]) => void; stop: () => void } {
  let words: readonly string[] = []
  let frame: number | null = null
  const repaint = () => { frame = null; onPaint(paintWords(root, kind, words)) }
  const soon = () => { if (frame === null) frame = requestAnimationFrame(repaint) }
  const watching = new MutationObserver(() => { if (words.length) soon() })
  watching.observe(root, { childList: true, subtree: true, characterData: true })
  return {
    set: next => { words = [...next]; soon() },
    stop: () => { watching.disconnect(); if (frame !== null) cancelAnimationFrame(frame); clearHighlights(kind) },
  }
}
