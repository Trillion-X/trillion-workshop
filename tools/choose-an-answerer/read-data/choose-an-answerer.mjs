// tools/choose-an-answerer/read-data/choose-an-answerer.mjs
//
// Purpose
//   Picks which AI answers one need: a waiting workflow step, a take-open-work task, or a model call (tool:ask-a-model).
//   One chooser for every lane, so no caller names a provider, an account or a model itself. Pure: it reads nothing and
//   writes nothing; the readers hand it the rows it decides from.
//
// Non-negotiable invariants
//   1. Which providers exist, their routes, weights, concurrency and fit tags are DATA (setting rows `answerer-choice/*`).
//      This file names no provider.
//   2. A model is only ever taken from `models`, the live lists the readers fetched (codex-lb /v1/models, the proxy
//      /v1/models). A row whose models are not in the live list is skipped; no model name is typed here.
//   3. A limit at or above the threshold (DATA `threshold_percent`), a `limited` state, or a cool-down still in force
//      skips that account for this decision. An unknown reading is not a free pass: it is skipped too.
//   4. A reviewer (need.role 'reviewer') never takes the maker's provider while another has room, and never the maker's model.
//   5. A row's optional prefer_below_percent is tried first; the threshold decides when every row is over its preference.
//   6. Never raises for a normal miss: it returns { none } with words saying why, so the caller can wait or refuse.
//
// Usage
//   import { chooseAnswerer } from './choose-an-answerer.mjs';
//   chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers, limits, models, cooldowns, now, threshold_percent })

/** The first pick a need fits, in the order of the providers rows (weight first, then their order in the list). */
export function chooseAnswerer(need = {}, { providers = [], limits = [], models = {}, cooldowns = [], now = new Date(), threshold_percent = 85 } = {}) {
  if (typeof need.kind !== 'string' || !need.kind) return { none: 'The need names no kind of answer to choose for.' };
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  const fits = row => (row.kinds ?? []).includes(need.kind) && (need.fit ?? []).every(tag => (row.fit ?? []).includes(tag));
  const candidates = providers.filter(row => row.enabled !== false && fits(row))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const why = [];
  const reviewing = need.role === 'reviewer' && need.avoid;
  // A reviewer is never the maker's provider while another provider has room; if only the maker's provider has room,
  // it takes another of that provider's models (never the maker's model), and `why` says so.
  const sameProvider = row => reviewing && row.provider === need.avoid.provider;
  const ordered = reviewing ? [...candidates.filter(row => !sameProvider(row)), ...candidates.filter(sameProvider)] : candidates;
  // Two passes: first each row's own preference (prefer_below_percent, e.g. Codex below 50% used), then the threshold.
  // A preferred row over its preference is still taken when no other row has room under the threshold.
  for (const pass of ['preferred', 'threshold']) {
    const reasons = [];
    for (const row of ordered) {
      const avoidModel = reviewing && sameProvider(row) ? need.avoid.model : null;
      const modelIds = (row.models ?? []).filter(id => (models[row.provider] ?? []).includes(id) && id !== avoidModel);
      if (!modelIds.length) { reasons.push(`${row.id}: none of its models is on the live list${avoidModel ? ' other than the maker\'s' : ''}`); continue; }
      const ceiling = pass === 'preferred' && row.prefer_below_percent !== undefined ? row.prefer_below_percent : threshold_percent;
      for (const account of row.account_pool ?? []) {
        const limit = limits.find(item => item.provider === row.provider && item.account === account && item.window_name === (row.window_name ?? 'weekly'));
        const cooling = cooldowns.find(item => item.provider === row.provider && item.account === account && Date.parse(item.until) > at);
        if (cooling) { reasons.push(`${row.provider} ${account}: cooling until ${cooling.until}`); continue; }
        if (!limit || limit.state === 'unknown' || limit.used_percent === null || limit.used_percent === undefined) { reasons.push(`${row.provider} ${account}: no reading`); continue; }
        if (limit.state === 'limited' || Number(limit.used_percent) >= ceiling) { reasons.push(`${row.provider} ${account}: ${limit.used_percent}% used, at or over ${ceiling}%`); continue; }
        const reason = `${row.id}: ${limit.used_percent}% used on ${account}`
          + (pass === 'threshold' && row.prefer_below_percent !== undefined ? ` (over its ${row.prefer_below_percent}% preference, taken because no other row has room under ${threshold_percent}%)` : '')
          + (reviewing && sameProvider(row) ? ` (reviewer: the maker's provider ${need.avoid.provider} was the only one with room, so another of its models answers)` : '');
        return { provider: row.provider, account, model: modelIds[0], why: reason };
      }
    }
    if (pass === 'threshold') why.push(...reasons);
  }
  return { none: why.length ? `Nothing fits the need: ${why.join('; ')}.` : 'No answerer row fits the need.' };
}
