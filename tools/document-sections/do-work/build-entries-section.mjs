#!/usr/bin/env node
// tools/document-sections/do-work/build-entries-section.mjs
//
// Purpose
//   Build one markdown section out of a list of entries, so the section can be
//   handed to append-section.mjs. This is the producing half of the same job
//   that file does: that one places a section, this one writes its bytes.
//
// Why the text is quoted and never touched
//   An entry is somebody's exact words. Reformatting it, trimming it, fixing
//   its spelling or collapsing its blank lines would make the document a
//   paraphrase while still looking like a record. Every line of an entry's text
//   is emitted with a blockquote marker in front of it and nothing else is
//   changed, so the bytes between the markers are the bytes that came in.
//
// Non-negotiable invariants
//   - Nothing here knows what the entries are about. The heading, the field
//     names to read, and the files to read them from are all inputs.
//   - It never reaches for a field by a name it invented. A source that names
//     no entries, or names a field that is not there, is refused rather than
//     rendered as an empty section, because an empty section and a section that
//     failed to find anything look identical once written.
//
// Usage
//   node build-entries-section.mjs --out <path> --heading <text>
//     --from <json> [--from <json> ...]
//     [--entries-at messages] [--text-field content] [--label-field ordinal]
//     [--stamp-field timestamp] [--group-field session_id] [--preamble <path>]

import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'

export class EntriesRefused extends Error {}

const quote = text =>
  String(text)
    .split('\n')
    .map(line => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n')

/**
 * The entry list inside one source document, found at a named key. A source
 * with no such key is an error and not an empty list, because the difference
 * between "nobody said anything" and "the key is spelled differently" is the
 * whole value of reading it.
 */
export function entriesOf(document, at, path) {
  const entries = document[at]
  if (!Array.isArray(entries)) {
    throw new EntriesRefused(
      `${path} has no array at \`${at}\`, so there is nothing to render. ` +
        `Keys present: ${Object.keys(document).join(', ')}`,
    )
  }
  return entries
}

export function renderEntry(entry, fields, path, position) {
  const text = entry[fields.text]
  if (typeof text !== 'string') {
    throw new EntriesRefused(
      `entry ${position} in ${path} has no string at \`${fields.text}\`, ` +
        'so rendering it would silently drop what it said',
    )
  }
  const marks = []
  if (fields.label && entry[fields.label] !== undefined) marks.push(`#${entry[fields.label]}`)
  if (fields.stamp && entry[fields.stamp] !== undefined) marks.push(String(entry[fields.stamp]))
  return `${marks.length > 0 ? `**${marks.join(' , ')}**\n\n` : ''}${quote(text)}`
}

export function renderSection({heading, preamble, sources, fields}) {
  const blocks = [heading.startsWith('#') ? heading : `## ${heading}`]
  if (preamble) blocks.push(preamble.trimEnd())
  let total = 0
  for (const source of sources) {
    const entries = entriesOf(source.document, fields.at, source.path)
    const group = fields.group ? source.document[fields.group] : null
    blocks.push(`### ${group ?? source.path} (${entries.length})`)
    entries.forEach((entry, index) => {
      blocks.push(renderEntry(entry, fields, source.path, index + 1))
      total += 1
    })
  }
  if (total === 0) {
    throw new EntriesRefused(
      'every source was empty, and writing an empty section would look exactly ' +
        'like a section that rendered correctly',
    )
  }
  return {bytes: `${blocks.join('\n\n')}\n`, total}
}

function readArguments(argv) {
  const single = new Map()
  const from = []
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    const key = argv[index].slice(2)
    const value = argv[index + 1]
    if (key === 'from') from.push(value)
    else single.set(key, value)
    index += 1
  }
  if (!single.get('out') || !single.get('heading') || from.length === 0) {
    throw new EntriesRefused(
      'usage: build-entries-section.mjs --out <path> --heading <text> --from <json> [--from <json> ...] ' +
        '[--entries-at messages] [--text-field content] [--label-field ordinal] ' +
        '[--stamp-field timestamp] [--group-field session_id] [--preamble <path>]',
    )
  }
  return {
    out: resolve(single.get('out')),
    heading: single.get('heading'),
    preamble: single.get('preamble') ? resolve(single.get('preamble')) : null,
    from: from.map(path => resolve(path)),
    fields: {
      at: single.get('entries-at') || 'messages',
      text: single.get('text-field') || 'content',
      label: single.get('label-field') || 'ordinal',
      stamp: single.get('stamp-field') || 'timestamp',
      group: single.get('group-field') || 'session_id',
    },
  }
}

export async function run(argv) {
  const {out, heading, preamble, from, fields} = readArguments(argv)
  const sources = []
  for (const path of from) {
    sources.push({path, document: JSON.parse(await readFile(path, 'utf8'))})
  }
  const {bytes, total} = renderSection({
    heading,
    preamble: preamble ? await readFile(preamble, 'utf8') : null,
    sources,
    fields,
  })
  await writeFile(out, bytes, 'utf8')
  return {wrote: out, entries: total, sources: from.length, bytes: Buffer.byteLength(bytes)}
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then(
    result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.message}\n`)
      process.exit(error instanceof EntriesRefused ? 2 : 1)
    },
  )
}
