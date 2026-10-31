// tools/document-sections/do-work/append-section.mjs
//
// Purpose
//   Place one named section into a markdown document, idempotently. The section
//   is identified by its own first heading line. If that heading already exists
//   in the document, the existing section is replaced through to the next
//   heading at the same or shallower depth. Otherwise the section is appended.
//
// Non-negotiable invariants
//   - The document is never truncated on failure: bytes are written to a
//     sibling staged path and renamed atomically inside the same directory.
//   - The section file supplies its own heading. This owner never invents,
//     renames, or reformats a heading.
//   - Nothing here knows what any document is about. Document path, section
//     bytes, and heading depth all arrive as inputs.
//
// Key concepts
//   A section runs from its heading line up to, but not including, the next
//   line that is a heading of the same depth or shallower. Fenced blocks are
//   skipped when locating boundaries, so a heading-looking line inside a fence
//   never ends a section.
//
// Security
//   This owner reads and writes exactly the two paths it is given. It resolves
//   both before use and never interpolates either into a shell.

import { readFile, writeFile, rename, stat } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+\S/

export function headingDepth(line) {
  const match = HEADING.exec(line)
  return match ? match[1].length : 0
}

export function firstHeading(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const depth = headingDepth(lines[index])
    if (depth > 0) return { index, line: lines[index], depth }
  }
  return null
}

/**
 * Find the [start, end) line range of the section whose heading line equals
 * `heading`, ignoring headings inside fenced blocks. Returns null when absent.
 */
export function locateSection(lines, heading, depth) {
  let fenced = false
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (start === -1) {
      if (line.trimEnd() === heading.trimEnd()) start = index
      continue
    }
    const found = headingDepth(line)
    if (found > 0 && found <= depth) return { start, end: index }
  }
  return start === -1 ? null : { start, end: lines.length }
}

export function placeSection(documentText, sectionText) {
  const sectionLines = sectionText.replace(/\s+$/, '').split('\n')
  const heading = firstHeading(sectionLines)
  if (!heading) throw new Error('the section file has no markdown heading, so it cannot be identified')
  const lines = documentText.split('\n')
  const existing = locateSection(lines, heading.line, heading.depth)
  if (existing) {
    const next = [...lines.slice(0, existing.start), ...sectionLines, '', ...lines.slice(existing.end)]
    return { text: `${next.join('\n').replace(/\s+$/, '')}\n`, placement: 'replaced', heading: heading.line }
  }
  const trimmed = documentText.replace(/\s+$/, '')
  return {
    text: `${trimmed}\n\n${sectionLines.join('\n')}\n`,
    placement: 'appended',
    heading: heading.line,
  }
}

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  const document = values.get('document')
  const section = values.get('section-file')
  if (!document || !section) {
    throw new Error('usage: append-section.mjs --document <path> --section-file <path>')
  }
  return { document: resolve(document), section: resolve(section) }
}

export async function run(argv) {
  const { document, section } = readArguments(argv)
  const before = await stat(document)
  const documentText = await readFile(document, 'utf8')
  const sectionText = await readFile(section, 'utf8')
  const result = placeSection(documentText, sectionText)
  const staged = join(dirname(document), `.${basename(document)}.staged`)
  await writeFile(staged, result.text, 'utf8')
  await rename(staged, document)
  const after = await stat(document)
  return {
    document,
    section,
    heading: result.heading,
    placement: result.placement,
    bytes_before: before.size,
    bytes_after: after.size,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then(
    (readback) => process.stdout.write(`${JSON.stringify(readback, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    },
  )
}
