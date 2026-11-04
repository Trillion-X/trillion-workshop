// tools/what-a-paste-becomes/show/paste-sources.ts (moved from Trillion-X/trillion parts/documents/read-data/paste-sources.ts)
//
// Purpose
//   A paste from another editor keeps its structure: the pasted HTML says where it came from (a signature that editor
//   writes on its clipboard), and each element is written as markdown by that source's own rules, then the default ones
//   (paste-sources.json). Documents take the markdown as blocks (DocumentEditor, pasteMarkdown); a list takes a pasted
//   table as rows (`tableRows`).
//
// Non-negotiable invariants
//   1. Sources, their signatures and every rule are DATA; nothing here names an editor.
//   2. The first matching rule decides an element: a source's own rules are asked first and fall through to the default
//      ones; an element no rule matches is written as its children, so an unknown element never loses its words.
//   3. Safe default: no HTML, an HTML that fails to read, or a conversion that throws answers null, and the caller uses
//      the plain text the paste carried. Nothing pasted is ever run (scripts and styles are dropped, never evaluated).

import settings from './paste-sources.json' with { type: 'json' }

type Rule = { tag?: string; parent?: string; attr_starts?: Record<string, string>; attr_contains?: Record<string, string>; class_contains?: string;
  before?: string; after?: string; block?: boolean; tight?: boolean; drop?: boolean; indent?: number; literal?: boolean }
type Source = { id: string; html_contains: string[]; rules: Rule[] }
export type PastedMarkdown = { source: string | null; markdown: string }

/** Where a pasted HTML came from: the first source whose signature it holds, or null (invariant 1). */
export function pasteSourceOf(html: string): string | null {
  return (settings.sources as Source[]).find(source => source.html_contains.some(mark => html.includes(mark)))?.id ?? null
}

const rulesFor = (source: string | null): Rule[] => [...((settings.sources as Source[]).find(row => row.id === source)?.rules ?? []), ...(settings.default_rules as Rule[])]

function matches(rule: Rule, element: Element): boolean {
  if (rule.tag && rule.tag !== element.tagName.toLowerCase()) return false
  if (rule.parent && rule.parent !== element.parentElement?.tagName.toLowerCase()) return false
  for (const [name, start] of Object.entries(rule.attr_starts ?? {})) if (!(element.getAttribute(name) ?? '').startsWith(start)) return false
  for (const [name, part] of Object.entries(rule.attr_contains ?? {})) if (!(element.getAttribute(name) ?? '').replace(/\s+/g, '').includes(part.replace(/\s+/g, ''))) return false
  if (rule.class_contains && !(element.getAttribute('class') ?? '').includes(rule.class_contains)) return false
  return true
}

const listDepth = (element: Element): number => { let depth = 0; for (let at = element.parentElement?.parentElement; at; at = at.parentElement) if (/^(ul|ol)$/i.test(at.tagName)) depth += 1; return depth }
const placeInList = (element: Element): number => [...(element.parentElement?.children ?? [])].filter(child => child.tagName === element.tagName).indexOf(element) + 1
const fill = (text: string, element: Element) => text.replace(/\{([a-z_-]+)\}/g, (_, name: string) => (name === 'n' ? String(placeInList(element)) : element.getAttribute(name) ?? ''))

function write(node: Node, rules: Rule[], literal: boolean): string {
  if (node.nodeType === 3) return literal ? node.nodeValue ?? '' : (node.nodeValue ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== 1) return ''
  const element = node as Element
  let rule: Rule | undefined
  for (const candidate of rules) if (matches(candidate, element)) { rule = candidate; break }
  if (rule?.drop) return ''
  const inner = [...element.childNodes].map(child => write(child, rules, literal || Boolean(rule?.literal))).join('')
  if (!rule) return inner
  const text = `${fill(rule.before ?? '', element)}${rule.block ? inner.trim() : inner}${fill(rule.after ?? '', element)}`
  if (!rule.block) return text
  const indent = rule.indent ? ' '.repeat(rule.indent * listDepth(element)) : ''
  // A tight block (a list item, a table row) starts a line of its own but sits directly under its neighbour.
  return rule.tight ? `\n${indent}${text}` : `\n\n${indent}${text}\n\n`
}

/** The markdown a pasted HTML is, written by its source's rules then the default ones; null to use the plain text (invariant 3). */
export function pastedMarkdown(html: string, parse: (html: string) => Document = text => new DOMParser().parseFromString(text, 'text/html')): PastedMarkdown | null {
  if (!html.trim()) return null
  try {
    const source = pasteSourceOf(html)
    const body = parse(html).body
    const markdown = write(body, rulesFor(source), false).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return markdown ? { source, markdown } : null
  } catch { return null }
}

/** A pasted table as rows of cell words (the first row its header), at most `table_rows`; null when it holds none. */
export function tableRows(html: string, parse: (html: string) => Document = text => new DOMParser().parseFromString(text, 'text/html')): string[][] | null {
  if (!html.includes('<t')) return null
  try {
    const source = pasteSourceOf(html)
    const rules = rulesFor(source).filter(rule => rule.tag !== 'td' && rule.tag !== 'th' && rule.tag !== 'tr')
    const table = parse(html).querySelector('table')
    if (!table) return null
    const rows = [...table.querySelectorAll('tr')].slice(0, settings.table_rows + 1)
      .map(row => [...row.children].filter(cell => /^(td|th)$/i.test(cell.tagName)).map(cell => write(cell, rules, false).replace(/\s+/g, ' ').trim()))
      .filter(cells => cells.some(Boolean))
    return rows.length ? rows : null
  } catch { return null }
}
