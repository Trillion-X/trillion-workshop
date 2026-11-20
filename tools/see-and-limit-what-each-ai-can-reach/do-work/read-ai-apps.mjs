// tools/see-and-limit-what-each-ai-can-reach/do-work/read-ai-apps.mjs
//
// tool:read-ai-apps: the facts of AI apps & keys for one account: its AI apps (one per client name, with its sign-ins),
// its personal keys, its pursuits and its webhooks. Ported from the old codebase's src/screen-reads.mjs readAiApps
// (commit b6ae0ebf815f), where the gather was the account's own operations. The caller hands in the account's records,
// and any part it could not read as null: pursuits and calls then say so, webhooks answer "could not be read". The
// gather is the owners that remain (src/ai-reach.mjs withReaches, web/src/sign-in-lifetimes.mjs, web/src/sign-in-calls.mjs),
// and the facts are web/src/ai-apps-screen.mjs aiAppsFacts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The records answered are the ones the caller hands in for its account; nothing here chooses an account.
//   2. A key is described by its name and last four characters only; its value is never read.
//   3. A part that cannot be read says so (no pursuits, no call counts, webhooks null), never an empty list that looks
//      like the truth.
import { withReaches } from '../src/ai-reach.mjs';
import { aiAppsFacts } from '../web/src/ai-apps-screen.mjs';
import { idleDaysOf } from '../web/src/sign-in-lifetimes.mjs';
import { callsTier } from '../web/src/sign-in-calls.mjs';

/**
 * AI apps & keys for one account. `grants` are its sign-ins (one per client sign-in, with clientName and reach), `keys` its
 * personal keys, `idles` each sign-in's idle days, `calls` the calls each sign-in made lately, `spaces` the pursuits and
 * `hooks` the webhooks (null for any of the three when it could not be read).
 */
export function readAiApps({ keys = [], grants = [], idles = {}, calls = null, spaces = [], hooks = null } = {}) {
  const apps = [...new Map(grants.map(grant => [grant.metadata.clientName, grant])).keys()].map(name => {
    const own = grants.filter(grant => grant.metadata.clientName === name);
    return { id: own[0].id, name, grant_ids: own.map(grant => grant.id), created_at: new Date(own[0].createdAt * 1000).toISOString(), last_used_at: null };
  });
  const ais = withReaches({ apps, grants, keys, reaches: {} });
  const used = calls ?? {};
  const callsOf = (ai, caller, approvedBy) => ({ limit: callsTier({ holds: [], caller, approved_by: approvedBy }).limit,
    used: (ai.sign_ins ?? []).reduce((sum, item) => sum + (used[item.sign_in] ?? 0), 0) });
  const idleOf = (ai, approvedBy) => idleDaysOf(approvedBy, idles[ai.sign_ins?.[0]?.sign_in] ?? null);
  return aiAppsFacts({
    apps: ais.apps.map(app => ({ ...app, idle_days: idleOf(app, null), calls: callsOf(app, 'app', null) })),
    keys: ais.keys.map(key => ({ ...key, idle_days: idleOf(key, 'key'), calls: callsOf(key, 'key', 'key') })),
    spaces: spaces ?? [], hooks,
  });
}
