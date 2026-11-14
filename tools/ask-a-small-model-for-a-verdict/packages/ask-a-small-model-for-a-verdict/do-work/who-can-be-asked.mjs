// packages/ask-a-small-model-for-a-verdict/do-work/who-can-be-asked.mjs
//
// Purpose
//   The judges on offer, read from the rubric file's `ask_in_order` rows: each
//   row names an adapter and where to reach it, and the adapter lists what it
//   serves there. The turn hook, the calibration run and the scoreboard all
//   ask the same question, so they read the same answer from here.
//
// Invariants
//   - A provider is DATA. Which adapter and where are fields of its row; no
//     provider is named in code.
//   - `phase: 'calibration'` differs only in the request time limit (the row's
//     `calibration_timeout_seconds`), never in which judges are offered, so the
//     calibration result is filed under the same key the turn reads.
//   - A provider that cannot list what it serves offers nothing; that is not
//     an error for the caller.

export const ADAPTERS = {
  'locally-served': () => import('../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-a-locally-served-model.mjs'),
  'hosted-classifier': () => import('../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-a-hosted-classifier.mjs'),
}

export const providersIn = settings =>
  (settings.ask_in_order ?? Object.keys(ADAPTERS)).map(one => (typeof one === 'string' ? {via: one} : one))

/** -> [{candidate, ask, via, provider}] in the rows' order. */
export async function whoCanBeAsked(settings, {phase = 'turn'} = {}) {
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
      for (const candidate of await adapter.candidates(provider)) {
        asking.push({candidate, ask: adapter.ask, via: provider.label ?? provider.via, provider})
      }
    } catch {
      // A provider that cannot list what it offers is simply not offering.
    }
  }
  return asking
}
