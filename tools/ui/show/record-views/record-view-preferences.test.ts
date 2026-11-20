import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { keepRecordViewPreferencesOnThisPage, writeRecordViewPreference, useRecordViewPreference } from './record-view-preferences.ts'

describe('a page with no account store keeps view choices without an error', () => {
  it('a write is accepted and the value is read back on this page', async () => {
    keepRecordViewPreferencesOnThisPage()
    await assert.doesNotReject(writeRecordViewPreference('record-views:posts', { view: 'chat' }))
    assert.deepEqual(useRecordViewPreference('record-views:posts'), { view: 'chat' })
    assert.equal(useRecordViewPreference('record-views:other'), null)
  })
})
