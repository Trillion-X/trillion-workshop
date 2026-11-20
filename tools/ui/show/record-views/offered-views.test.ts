import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickOfferedViews } from './offered-views.ts'

const views = ['table', 'board', 'chat', 'feed', 'forum', 'sheet', 'calendar'].map(id => ({ id, label: id }))
const ids = (picked: { id: string }[]) => picked.map(view => view.id)

describe('the views a list offers', () => {
  it('offers every view when the list names none', () => {
    assert.deepEqual(ids(pickOfferedViews(views, undefined)), ids(views))
    assert.deepEqual(ids(pickOfferedViews(views, [])), ids(views))
  })
  it('offers only the named views, in the order the list names them', () => {
    assert.deepEqual(ids(pickOfferedViews(views, ['forum', 'chat', 'feed', 'table'])), ['forum', 'chat', 'feed', 'table'])
  })
  it('leaves out an id no offered view has, and an id named twice', () => {
    assert.deepEqual(ids(pickOfferedViews(views, ['chat', 'no-such-view', 'chat'])), ['chat'])
  })
  it('does not change the views it was given', () => {
    const given = [...views]
    pickOfferedViews(views, ['feed'])
    assert.deepEqual(views, given)
  })
})
