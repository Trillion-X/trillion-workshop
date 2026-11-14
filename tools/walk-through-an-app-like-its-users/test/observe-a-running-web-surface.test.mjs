import { strict as assert } from 'node:assert'
import test from 'node:test'
import { observe, locate, ACTIONS, OBSERVATIONS } from '../do-work/observe-surface.mjs'

// A fake page. The point of these checks is the runner's discipline, not a
// browser: that a blocked step is reported instead of thrown, that observations
// still run after a failed step, and that a step's own label can never be
// mistaken for an accessible name.
function fakePage(behaviour = {}) {
  const calls = []
  const locator = name => ({
    click: async () => { calls.push(['click', name]); if (behaviour.clickThrows) throw new Error(behaviour.clickThrows) },
    fill: async value => calls.push(['fill', name, value]),
    press: async key => calls.push(['press', name, key]),
    waitFor: async () => { calls.push(['waitFor', name]); if (behaviour.waitThrows) throw new Error(behaviour.waitThrows) },
  })
  return {
    calls,
    goto: async url => calls.push(['goto', url]),
    waitForTimeout: async ms => calls.push(['wait', ms]),
    screenshot: async () => calls.push(['screenshot']),
    locator: selector => ({ first: () => locator(`selector:${selector}`) }),
    getByRole: (role, options) => ({ first: () => locator(`role:${role}:${options.name}`) }),
    getByText: text => ({ first: () => locator(`text:${text}`) }),
    evaluate: async (fn, spec) => (behaviour.evaluate ? behaviour.evaluate(spec) : { echoed: spec }),
    on: () => {},
  }
}

const fakeChromium = page => ({ launch: async () => ({ newPage: async () => page, close: async () => {} }) })

test('a step label is never used as an accessible name', () => {
  const page = fakePage()
  locate(page, { name: 'open the thing', role: 'button', role_name: 'Library' })
  assert.equal(page.calls.length, 0)
  const target = locate(page, { name: 'open the thing', role: 'button', role_name: 'Library' })
  return target.click().then(() => assert.deepEqual(page.calls.at(-1), ['click', 'role:button:Library']))
})

test('a step with no target is refused rather than guessing one', () => {
  assert.throws(() => locate(fakePage(), { name: 'nothing' }), /selector, role or text/)
})

test('a blocked step is reported and the run continues', async () => {
  const page = fakePage({ clickThrows: 'Timeout 15000ms exceeded.' })
  const result = await observe({
    url: 'http://example.test',
    steps: [
      { name: 'press it', do: 'click', selector: '#a' },
      { name: 'carry on', do: 'wait_ms', ms: 1 },
    ],
  }, { chromium: fakeChromium(page) })
  assert.equal(result.steps[0].completed, false)
  assert.match(result.steps[0].blocked_by, /Timeout/)
  assert.equal(result.steps[1].completed, true)
})

test('observations still run after the step that preceded them failed', async () => {
  const page = fakePage({ clickThrows: 'nope', evaluate: spec => ({ saw: spec.selector }) })
  const result = await observe({
    steps: [{ name: 'press it', do: 'click', selector: '#a', observe: { state: { read: 'count', selector: '#b' } } }],
  }, { chromium: fakeChromium(page) })
  assert.equal(result.steps[0].completed, false)
  assert.deepEqual(result.steps[0].state, { saw: '#b' })
})

test('an unknown step or observation names itself instead of crashing the run', async () => {
  const result = await observe({
    steps: [{ name: 'weird', do: 'teleport', observe: { x: { read: 'divine' } } }],
  }, { chromium: fakeChromium(fakePage()) })
  assert.match(result.steps[0].blocked_by, /no such step: teleport/)
  assert.match(result.steps[0].x.error, /no such observation: divine/)
})

test('the runner offers no way to intercept or stub the page', () => {
  // A plan that could mock its own subject would observe nothing real, which is
  // the exact failure this package exists to make impossible.
  const page = fakePage()
  assert.equal(typeof page.route, 'undefined')
  assert.equal(Object.keys(ACTIONS).some(name => /route|mock|stub|intercept/i.test(name)), false)
})

test('every declared observation is a function', () => {
  for (const [name, reader] of Object.entries(OBSERVATIONS)) assert.equal(typeof reader, 'function', name)
})

test('page errors are collected onto the readback', async () => {
  const result = await observe({ steps: [] }, { chromium: fakeChromium(fakePage()) })
  assert.deepEqual(result.page_errors, [])
})
