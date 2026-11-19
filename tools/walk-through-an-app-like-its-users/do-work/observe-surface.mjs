// packages/web-surface-observation/do-work/observe-surface.mjs
//
// Purpose
//   Drive a running web surface through a declared sequence of steps and report
//   what it actually rendered. The answer to "does this control work" comes from
//   the running product, never from an intercepted or stubbed page.
//
// Non-negotiable invariants
//   - This owner asserts nothing and fails nothing. It reports. A step that
//     cannot complete is recorded as an observation, not an exception, because
//     a run that aborts halfway hides the state that explains the failure.
//   - No application, route, selector, label or product name appears here.
//     Every one of those is a field of the DATA plan it is handed.
//   - The page is never intercepted, stubbed or routed. Requests reach the real
//     server. A plan that mocks its own subject observes nothing.
//
// Key concepts
//   A plan is {url, viewport?, steps[]}. A step has a `do` (what to perform) and
//   an optional `observe` (what to read afterwards). Both vocabularies are
//   dispatched through a capability map, so a new kind of step or observation is
//   a new entry in that map plus a DATA row, never a branch added to a runner.
//
// Security
//   Only the URL named in the plan is visited. Nothing is written except the
//   readback file the caller names.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

/** What a step can DO. Adding a verb is an entry here, never a branch below. */
export const ACTIONS = {
  goto: async (page, step) => { await page.goto(step.url, { waitUntil: step.wait_until || 'domcontentloaded' }); },
  click: async (page, step) => { await locate(page, step).click({ timeout: step.timeout_ms || 15000 }); },
  fill: async (page, step) => { await locate(page, step).fill(step.value ?? ''); },
  // A key aimed at an element goes to that element. A key with no target named
  // goes to the page, which is the only way to reach whatever currently holds
  // focus: an open menu, a dialog, a popover. Requiring a target made every
  // Escape unreachable, so a probe could open a menu and never close it, and
  // the still-open menu then swallowed every click that followed.
  press: async (page, step) => {
    const targeted = step.selector || step.role || step.text
    if (targeted) await locate(page, step).press(step.key)
    else await page.keyboard.press(step.key)
  },
  wait_for: async (page, step) => { await locate(page, step).waitFor({ timeout: step.timeout_ms || 30000 }); },
  wait_ms: async (page, step) => { await page.waitForTimeout(step.ms || 1000); },
  screenshot: async (page, step) => { await page.screenshot({ path: step.path, fullPage: Boolean(step.full_page) }); },
}

/** What a step can OBSERVE. Each returns plain JSON. */
export const OBSERVATIONS = {
  // Every element matching a selector, with the properties the plan asked for.
  elements: (page, spec) => page.evaluate(({ selector, limit }) => {
    return [...document.querySelectorAll(selector)].slice(0, limit || 50).map((node, index) => {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return {
        index,
        tag: node.tagName.toLowerCase(),
        label: node.getAttribute('aria-label') || node.getAttribute('name') || (node.textContent || '').trim().slice(0, 80),
        visible: Boolean(node.offsetWidth || node.offsetHeight),
        disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true',
        cursor: style.cursor,
        pointer_events: style.pointerEvents,
        z_index: style.zIndex,
        position: style.position,
        opacity: style.opacity,
        rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        // The single most useful fact about a control nobody can click: what
        // the pointer would actually land on at this element's own centre.
        pointer_would_hit: hit ? hit.tagName.toLowerCase() + (hit.getAttribute('aria-label') ? `[${hit.getAttribute('aria-label')}]` : '') : null,
        pointer_is_self: hit ? node.contains(hit) : false,
      }
    })
  }, spec),
  // How many nodes match, and nothing else. Cheap for large sweeps.
  count: (page, spec) => page.evaluate(({ selector }) => document.querySelectorAll(selector).length, spec),
  // Milliseconds until a media element reports it can play, or a timeout.
  media_ready: (page, spec) => page.evaluate(async ({ selector, timeout_ms }) => {
    const media = document.querySelector(selector)
    if (!media) return { found: false }
    if (media.readyState >= 3) return { found: true, ms: 0, ready_state: media.readyState }
    const started = performance.now()
    const ok = await new Promise(done => {
      media.addEventListener('canplay', () => done(true), { once: true })
      setTimeout(() => done(false), timeout_ms || 30000)
    })
    return { found: true, ms: Math.round(performance.now() - started), reached_canplay: ok, ready_state: media.readyState }
  }, spec),
  // Whether a dotted path exists on `window`, and what kind of thing it is.
  // A read-only walk, never an evaluation: a plan names a path, not an
  // expression, so this cannot become a way to run code on the page.
  global_path: (page, spec) => page.evaluate(({ path }) => {
    let node = window
    const walked = []
    for (const key of String(path).split('.')) {
      if (node === null || node === undefined) return {found: false, walked, missing: key}
      node = node[key]
      walked.push(key)
    }
    return {found: node !== undefined, walked, type: typeof node}
  }, spec),
  // Named attributes and form values off matched elements. `elements` reports a
  // human label, which for a dropdown is every option's text run together and
  // tells you nothing about which one is chosen.
  attributes: (page, spec) => page.evaluate(({ selector, names, limit }) =>
    [...document.querySelectorAll(selector)].slice(0, limit || 20).map(node => {
      const row = {tag: node.tagName.toLowerCase(), value: node.value ?? null, children: node.childElementCount}
      for (const name of names || []) row[name] = node.getAttribute(name)
      return row
    }), spec),
  text: (page, spec) => page.evaluate(({ selector }) => {
    const node = document.querySelector(selector)
    return node ? (node.textContent || '').trim().slice(0, 2000) : null
  }, spec),
}

// `name` is the step's own human label, so an accessible name is `role_name`.
// Reusing one key for both is how a step silently targets the wrong node.
export function locate(page, step) {
  if (step.selector) return page.locator(step.selector).first()
  if (step.role) return page.getByRole(step.role, { name: step.role_name, exact: step.exact !== false }).first()
  if (step.text) return page.getByText(step.text, { exact: step.exact !== false }).first()
  throw new Error('a step needs one of selector, role or text')
}

export async function observe(plan, { chromium }) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: plan.viewport || { width: 1440, height: 960 } })
  const page_errors = []
  page.on('pageerror', error => page_errors.push(String(error.message)))
  page.on('console', message => { if (message.type() === 'error') page_errors.push(`console: ${message.text()}`) })
  const steps = []
  try {
    if (plan.url) await ACTIONS.goto(page, { url: plan.url, wait_until: plan.wait_until })
    for (const step of plan.steps || []) {
      const started = Date.now()
      const record = { name: step.name || step.do, did: step.do }
      try {
        const action = ACTIONS[step.do]
        if (!action) throw new Error(`no such step: ${step.do}`)
        await action(page, step)
        record.completed = true
      } catch (error) {
        record.completed = false
        record.blocked_by = String(error.message || error).split('\n')[0].slice(0, 300)
      }
      record.ms = Date.now() - started
      for (const [key, spec] of Object.entries(step.observe || {})) {
        const reader = OBSERVATIONS[spec.read]
        if (!reader) { record[key] = { error: `no such observation: ${spec.read}` }; continue }
        try { record[key] = await reader(page, spec) }
        catch (error) { record[key] = { error: String(error.message || error).slice(0, 300) } }
      }
      steps.push(record)
    }
  } finally {
    await browser.close()
  }
  return { url: plan.url, page_errors, steps }
}

export async function run(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1]); index += 1
  }
  const planPath = values.get('plan')
  if (!planPath) throw new Error('usage: observe-surface.mjs --plan <json path> [--readback <json path>]')
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'))
  const { chromium } = await import('playwright')
  const readback = await observe(plan, { chromium })
  const out = values.get('readback')
  if (out) { await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(resolve(out), JSON.stringify(readback, null, 2)) }
  return readback
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  run(process.argv.slice(2)).then(
    readback => process.stdout.write(`${JSON.stringify(readback, null, 2)}\n`),
    error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 },
  )
}
