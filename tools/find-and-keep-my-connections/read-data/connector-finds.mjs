// Find a connector (src/connector-catalog.mjs) for one account: the catalogs' first page with the counts they report,
// kept an hour for everyone, and each person's own last search, kept an hour for them. The Connections screen reads
// these and never waits on a catalog it already asked.
// The host's records doors replace Worker KV. userId is retained for source callers but never selects an account.
import { connectorCatalog } from '../src/connector-catalog.mjs';

const KEPT_SECONDS = 3600;
const TYPE = 'connector-find';
const OWN_ID = 'connector-find:last';
const SHARED_ID = 'connector-find:everyone';
const catalogOf = env => connectorCatalog({ data: env.data, request: env.request, timeoutMs: 8000 });
const now = host => (host.now ?? Date.now)();
async function cached(door, id, at) {
  const row = await door.read(TYPE, id);
  return row && Number.isFinite(row.expires_at) && row.expires_at > at ? row.found : null;
}
const keep = (door, id, found, at) => door.write([{ id, type: TYPE, value: { found, expires_at: at + KEPT_SECONDS * 1000 } }]);

/** The catalogs' labels and the search to show: the person's own last one, else everyone's first page.
 * `door` belongs to the invoking account; `sharedDoor`, when supplied, is bound by the host, never by input.
 * `data` reads the current catalog rows. Unknown record reads propagate instead of looking like an absent cache. */
export async function connectorsFor(env, userId) {
  const catalog = catalogOf(env);
  const labels = await catalog.labels().catch(() => []);
  const own = await cached(env.door, OWN_ID, now(env));
  if (own) return { catalogs: labels, found: own };
  let everyone = env.sharedDoor ? await cached(env.sharedDoor, SHARED_ID, now(env)) : null;
  if (!everyone && labels.length) {
    everyone = await catalog.find({ text: '' }).catch(() => null);
    if (everyone?.sources.some(source => source.reached) && env.sharedDoor) await keep(env.sharedDoor, SHARED_ID, everyone, now(env));
  }
  return { catalogs: labels, found: everyone ?? null };
}

/** Searches the catalogs for `text` (from `page`) and keeps the answer as this person's last search. */
export async function findConnectors(env, userId, { text, page = null }) {
  const found = await catalogOf(env).find({ text, page });
  await keep(env.door, OWN_ID, found, now(env));
  return found;
}
