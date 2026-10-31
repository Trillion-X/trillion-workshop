// Proof for build-entries-section.mjs.
//
// The point of this owner is that the text it copies is unchanged, so the tests
// that matter most feed it text that any well-meaning formatter would want to
// tidy up: blank lines, trailing spaces, markdown that looks like structure,
// and a fenced block. If any of that comes out different, the document is a
// paraphrase wearing a record's clothes.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {renderSection, entriesOf, run, EntriesRefused} from '../do-work/build-entries-section.mjs'

const FIELDS = {at: 'messages', text: 'content', label: 'ordinal', stamp: 'timestamp', group: 'session_id'}

const withFiles = async (documents, body) => {
  const directory = await mkdtemp(join(tmpdir(), 'entries-section-'))
  const paths = []
  for (const [index, document] of documents.entries()) {
    const path = join(directory, `source-${index}.json`)
    await writeFile(path, JSON.stringify(document), 'utf8')
    paths.push(path)
  }
  try {
    return await body(paths, join(directory, 'section.md'))
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}

test('every line of an entry survives, including blank lines and trailing spaces', () => {
  const text = 'first line  \n\nthird line after a blank\n    indented\n'
  const {bytes} = renderSection({
    heading: 'Said',
    preamble: null,
    sources: [{path: 'p', document: {session_id: 's', messages: [{ordinal: 1, content: text}]}}],
    fields: FIELDS,
  })
  const quoted = bytes
    .split('\n')
    .filter(line => line.startsWith('>'))
    .map(line => (line === '>' ? '' : line.slice(2)))
    .join('\n')
  assert.equal(quoted, text, 'the text between the markers must be the text that came in')
})

test('markdown inside an entry is quoted, not interpreted as document structure', () => {
  const text = '# not a heading of this document\n```\n## not one either\n```'
  const {bytes} = renderSection({
    heading: 'Said',
    preamble: null,
    sources: [{path: 'p', document: {session_id: 's', messages: [{ordinal: 1, content: text}]}}],
    fields: FIELDS,
  })
  for (const line of text.split('\n')) assert.ok(bytes.includes(`> ${line}`), `line not quoted: ${line}`)
  assert.equal(bytes.split('\n').filter(line => /^#{1,6}\s/.test(line)).length, 2, 'only the section and group headings')
})

test('a source naming no entry array is refused, and the refusal says what keys it found', () => {
  assert.throws(
    () => entriesOf({user_messages: []}, 'messages', 'p.json'),
    error => error instanceof EntriesRefused && /user_messages/.test(error.message),
  )
})

test('an entry whose text field is missing is refused rather than rendered blank', () => {
  assert.throws(
    () =>
      renderSection({
        heading: 'Said',
        preamble: null,
        sources: [{path: 'p', document: {session_id: 's', messages: [{ordinal: 1, text: 'wrong field'}]}}],
        fields: FIELDS,
      }),
    /entry 1 in p/,
  )
})

test('sources that hold nothing are refused, because an empty section reads as a working one', () => {
  assert.throws(
    () =>
      renderSection({
        heading: 'Said',
        preamble: null,
        sources: [{path: 'p', document: {session_id: 's', messages: []}}],
        fields: FIELDS,
      }),
    /would look exactly/,
  )
})

test('entries keep their order and their group, across several sources', async () => {
  await withFiles(
    [
      {session_id: 'first', messages: [{ordinal: 1, content: 'one'}, {ordinal: 2, content: 'two'}]},
      {session_id: 'second', messages: [{ordinal: 1, content: 'three'}]},
    ],
    async (paths, out) => {
      const result = await run(['--out', out, '--heading', 'What was said', ...paths.flatMap(p => ['--from', p])])
      assert.equal(result.entries, 3)
      assert.equal(result.sources, 2)
      const written = await readFile(out, 'utf8')
      assert.match(written, /^## What was said/)
      assert.match(written, /### first \(2\)/)
      assert.match(written, /### second \(1\)/)
      assert.ok(
        written.indexOf('one') < written.indexOf('two') && written.indexOf('two') < written.indexOf('three'),
        'order must be the order they were said in',
      )
    },
  )
})

test('the field names are inputs, so a document using different names still renders', async () => {
  await withFiles([{thread: 'T', notes: [{n: 4, body: 'a note'}]}], async (paths, out) => {
    const result = await run([
      '--out', out,
      '--heading', 'Notes',
      '--from', paths[0],
      '--entries-at', 'notes',
      '--text-field', 'body',
      '--label-field', 'n',
      '--stamp-field', 'nothing-here',
      '--group-field', 'thread',
    ])
    assert.equal(result.entries, 1)
    const written = await readFile(out, 'utf8')
    assert.match(written, /### T \(1\)/)
    assert.match(written, /\*\*#4\*\*/)
    assert.match(written, /> a note/)
  })
})

test('a heading already written as markdown is used as given, never doubled', () => {
  const {bytes} = renderSection({
    heading: '# Top level',
    preamble: null,
    sources: [{path: 'p', document: {session_id: 's', messages: [{ordinal: 1, content: 'x'}]}}],
    fields: FIELDS,
  })
  assert.match(bytes, /^# Top level\n/)
})

test('no output path or no source is a usage error, never a silent empty file', async () => {
  await assert.rejects(() => run([]), /usage:/)
  await assert.rejects(() => run(['--out', '/tmp/x.md', '--heading', 'H']), /usage:/)
})
