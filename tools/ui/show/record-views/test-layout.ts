// packages/ui/show/record-views/test-layout.ts
//
// Purpose: jsdom lays nothing out, so every element is 0 px wide, and a gallery
// measures its width to know how many cards fit a line (a 0-wide gallery is a
// hidden one and draws nothing). Test files that render a gallery call this
// once to give elements a desktop width for the duration of the file.

import {afterAll, beforeAll} from '../../../../test-helpers/vitest-shim.mjs'

export function giveElementsAWidth(width = 1000) {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'clientWidth', {configurable: true, get: () => width}) })
  afterAll(() => { if (own) Object.defineProperty(HTMLElement.prototype, 'clientWidth', own) })
}
