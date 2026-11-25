import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { composeOf, newRecordId } from './view-designs.ts'
import { addMember, emptyGraph, ensureGroup } from '../../../turn-frames-into-slides/read-data/group-graph.ts'
import designed from './designs/designed-views.json' with { type: 'json' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const body = { id: 'body', label: 'Body', kind: 'text', document: true } as any
const ref = (id: string) => ({ family: 'list-row', parts: { id } })

// A list as a design receives it: its records, how it names one, its nesting and, when it keeps changes, its write.
function listOf(records: { id: string }[], { nested = {} as Record<string, string[]>, keeps = true } = {}) {
  let graph = emptyGraph()
  for (const [parent, members] of Object.entries(nested)) {
    graph = ensureGroup(graph, ref(parent))
    for (const member of members) graph = addMember(graph, ref(parent), ref(member), { memberId: member })
  }
  const kept: unknown[] = []
  const context = {
    records, identify: (record: { id: string }) => record.id, fields: [body], nesting: { graph },
    ...(keeps ? { write: async (changes: unknown[]) => { kept.push(changes) } } : {}),
  } as any
  return { context, kept }
}

describe('a list that keeps changes takes words in its designs', () => {
  it('gets a box, and sending writes one new record holding the words', async () => {
    const { context, kept } = listOf([{ id: 'a1b2c3d4-0000-4000-8000-000000000001' }])
    const compose = composeOf(context, body)
    assert.ok(compose, 'a writable list gets a box')
    await compose.send({ text: 'Hello all' })
    assert.equal(kept.length, 1)
    const [made] = kept[0] as any[]
    assert.equal((kept[0] as any[]).length, 1)
    assert.match(made.id, UUID)
    assert.deepEqual({ ...made, id: '' }, { id: '', create: true, values: { body: 'Hello all' } })
  })

  it('a reply is a new record and the record it answers holds it last', async () => {
    const { context, kept } = listOf([{ id: 'post-1' }, { id: 'reply-1' }], { nested: { 'post-1': ['reply-1'] } })
    await composeOf(context, body)!.send({ text: 'Agreed', parent: 'post-1' })
    const [made, parent] = kept[0] as any[]
    assert.equal(made.create, true)
    assert.deepEqual(parent, { id: 'post-1', members: ['reply-1', made.id] })
  })

  it("a new record's id takes the form the list's own ids carry", () => {
    assert.match(newRecordId([{ id: 'record:space-item:0f0e0d0c-0000-4000-8000-000000000001' }], (record: any) => record.id), /^record:space-item:[0-9a-f-]{36}$/)
    assert.match(newRecordId([{ id: '0f0e0d0c-0000-4000-8000-000000000001' }], (record: any) => record.id), UUID)
    assert.match(newRecordId([], (record: any) => record.id), UUID)
  })

  it("the list's own compose wins over one made from its write", () => {
    const { context } = listOf([])
    const own = { send: async () => {} }
    assert.equal(composeOf({ ...context, compose: own }, body), own)
  })
})

describe('a list that takes no words draws no box', () => {
  it('without a write, read only, or with a words field that cannot be typed into', () => {
    assert.equal(composeOf(listOf([], { keeps: false }).context, body), undefined)
    assert.equal(composeOf({ ...listOf([]).context, readOnly: true }, body), undefined)
    assert.equal(composeOf(listOf([]).context, { ...body, editable: false }), undefined)
    assert.equal(composeOf(listOf([]).context, undefined), undefined)
  })

  it('and the words a design shows when it is empty point at no box', () => {
    for (const row of designed.views.filter(view => view.design === 'chat' || view.design === 'thread')) {
      const words = (row.options as Record<string, string>).empty_read_only
      assert.ok(words, `${row.id} has words for an empty list with no box`)
      assert.doesNotMatch(words, /below|above|write|start/i, `${row.id}: "${words}"`)
    }
  })
})
