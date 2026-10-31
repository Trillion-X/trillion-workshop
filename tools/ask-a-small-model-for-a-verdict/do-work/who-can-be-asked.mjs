// tools/ask-a-small-model-for-a-verdict/do-work/who-can-be-asked.mjs
//
// Purpose
//   The judges on offer, read from the caller's `ask_in_order` provider rows:
//   each row names an adapter and where to reach it, and the adapter lists what
//   it serves there. Asking, calibrating and the scoreboard all ask the same
//   question, so they read the same answer from here.
//
// Invariants
//   - A provider is DATA. Which adapter and where are fields of its row; no
//     provider is named in code, and no row means nobody to ask.
//   - What each adapter needs from its row is stated, so a missing value is a
//     refusal that names it. No address, time limit or sample count is assumed.
//   - `phase: 'calibration'` differs only in the request time limit (the row's
//     `calibration_timeout_seconds`), never in which judges are offered, so the
//     calibration result is filed under the same key an ask reads.
//   - A row's `only_for_rubrics` (rubric ids) limits what it may be asked: the
//     candidate carries it and `candidatesFor` (ask-for-a-verdict) enforces it.
//   - A provider that cannot list what it serves offers nothing; that is not
//     an error for the caller.
//   - ADAPTERS is the one table of adapters. A caller with an adapter of its own
//     adds a row to it (a name and a loader); nothing here changes.

import {readFileSync, writeFileSync, mkdirSync, renameSync, rmSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {homedir} from 'node:os'
import {askingForCandidate, blake3Material, VerdictRefused} from './ask-for-a-verdict.mjs'
import {PROTOCOLS} from './ask-a-locally-served-model.mjs'

export const ADAPTERS = {
  'locally-served': () => import('./ask-a-locally-served-model.mjs'),
  'hosted-classifier': () => import('./ask-a-hosted-classifier.mjs'),
}

const isText = value => typeof value === 'string' && value.trim() !== ''
const isPositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0

const ROW_NEEDS = {
  'locally-served': [
    ['endpoint', isText, 'where the model server is'],
    ['timeout_seconds', isPositive, 'how many seconds one request may take (a model that must first load can hold every question until the caller gives up)'],
    ['protocol', value => Object.hasOwn(PROTOCOLS, value), `how the server is spoken to (${Object.keys(PROTOCOLS).join(', ')})`],
  ],
  'hosted-classifier': [
    ['endpoint', isText, 'where the classifier is'],
    ['model', isText, 'which model to ask'],
    ['samples', value => Number.isInteger(value) && value >= 1, 'how many times one question is asked and averaged (1 or more)'],
  ],
}

/** The provider rows of `settings.ask_in_order`, each checked for what its adapter needs. A row naming an adapter
 * nobody added offers nothing. */
export function providersIn(settings) {
  const rows = settings?.ask_in_order
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new VerdictRefused(
      'at least one provider row is required: {via: "locally-served" | "hosted-classifier", endpoint, ...}',
    )
  }
  return rows.map((one, index) => {
    const row = typeof one === 'string' ? {via: one} : one
    for (const [field, ok, what] of ROW_NEEDS[row?.via] ?? []) {
      if (!ok(row[field])) throw new VerdictRefused(`provider row ${index + 1} (${row.via}) needs ${field}: ${what}`)
    }
    return row
  })
}

const observedBuilds = new Map()
const defaultIdentityRead = url => fetch(url, {signal: AbortSignal.timeout(1000)}).then(reply => {
  if (!reply.ok) throw new Error('identity unavailable')
  return reply.json()
})

/** A bounded health lookup, never a completion request. Unknown is explicit. */
export async function readIdentity(provider, fetchJson = defaultIdentityRead, {refresh = false, now = Date.now()} = {}) {
  const from = provider?.identity_from
  if (!from?.url || !from?.field) return null
  const key = JSON.stringify([from.url, from.field])
  const current = kept => kept && now >= kept.at && now - kept.at < 30000 &&
    (kept.value === null || typeof kept.value === 'string' && kept.value.length <= 1024)
  // Callers start fresh processes. Share only this short-lived health observation,
  // never credentials, prompts, or calibration results; calibration always refreshes.
  let cachePath = null
  if (fetchJson === defaultIdentityRead) {
    try { cachePath = join(homedir(), '.cache', 'ask-a-small-model-identities', `${blake3Material(key)}.json`) } catch {}
  }
  let kept = observedBuilds.get(key)
  if (!refresh && !current(kept) && cachePath) {
    try { kept = JSON.parse(readFileSync(cachePath, 'utf8')) } catch {}
  }
  if (!refresh && current(kept)) return kept.value
  let value = null
  try {
    const identity = (await fetchJson(from.url))?.[from.field]
    if (typeof identity === 'string' && identity.length > 0 && identity.length <= 1024) value = identity
  } catch {}
  if (observedBuilds.size >= 64) observedBuilds.delete(observedBuilds.keys().next().value)
  observedBuilds.set(key, {at: now, value})
  if (cachePath) {
    const temporary = `${cachePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(cachePath), {recursive: true, mode: 0o700})
      writeFileSync(temporary, JSON.stringify({at: now, value}), {mode: 0o600, flag: 'wx'})
      renameSync(temporary, cachePath)
    } catch {} finally { try { rmSync(temporary, {force: true}) } catch {} }
  }
  return value
}

/** -> [{candidate, ask, askMany, via, provider}] in the rows' order. */
export async function whoCanBeAsked(settings, {phase = 'ask', readBuildIdentity = readIdentity} = {}) {
  const asking = []
  for (const row of providersIn(settings)) {
    const load = ADAPTERS[row.via]
    if (!load) continue
    const provider = phase === 'calibration' && Number(row.calibration_timeout_seconds) > 0
      ? {...row, timeout_seconds: row.calibration_timeout_seconds}
      : row
    try {
      const adapter = await load()
      if (typeof adapter.configure === 'function') adapter.configure(provider)
      const identity = await readBuildIdentity(provider, undefined, {refresh: phase === 'calibration'})
      for (const candidate of await adapter.candidates(provider)) {
        // A row that names the rubrics it may be asked about marks its candidate so no other rubric is ever sent to it.
        const scoped = {...candidate,
          ...(Array.isArray(provider.only_for_rubrics) ? {only_for_rubrics: provider.only_for_rubrics} : {}),
          ...(provider.identity_from ? {identity: identity ?? null, identity_required: true} : {}),
        }
        asking.push({candidate: scoped, ask: adapter.ask, askMany: adapter.askMany, via: provider.label ?? provider.via, provider})
      }
    } catch {
      // A provider that cannot list what it offers is simply not offering.
    }
  }
  return asking
}

/** The offered candidates and one `ask` that sends each question to the adapter that offered the candidate. */
export async function classifiersFrom(settings, options) {
  const asking = await whoCanBeAsked(settings, options)
  return {
    candidates: asking.map(one => one.candidate),
    // The route that offered the chosen candidate, never another adapter's model that shares its name.
    ask: args => askingForCandidate(asking, args.candidate).ask(args),
  }
}
