// Find a connector (src/connector-catalog.mjs) for one account: the catalogs' first page with the counts they report, and each
// person's own last search. Each find is good for an hour. This file keeps nothing: the host hands in the earlier finds it holds
// (`env.earlier`, { own, everyone }, each { found, expires_at }), an earlier find still fresh is answered without asking a
// catalog, and a find that must be kept comes back as `to_keep` for the host's own write. The Connections screen reads these and
// never waits on a catalog it already asked. No Worker KV, records door or user-id-selected store is used.
import { connectorCatalog } from '../src/connector-catalog.mjs';

const KEPT_SECONDS = 3600;
const catalogOf = env => connectorCatalog({ data: env.data, request: env.request, timeoutMs: 8000 });
const now = host => (host.now ?? Date.now)();
const freshFind = (earlier, at) => (earlier && Number.isFinite(earlier.expires_at) && earlier.expires_at > at ? earlier.found : null);
const toKeep = (found, at) => ({ found, expires_at: at + KEPT_SECONDS * 1000 });

/** The catalogs' labels and the search to show: the person's own last one, else everyone's first page.
 * `data` reads the current catalog rows; `earlier` is what the host kept of the finds this returned before.
 * Answers { catalogs, found, to_keep }: `to_keep.everyone` is the first page to keep when a catalog was reached for it, else null. */
export async function connectorsFor(env, userId) {
  const catalog = catalogOf(env);
  const labels = await catalog.labels().catch(() => []);
  const at = now(env);
  const own = freshFind(env.earlier?.own, at);
  if (own) return { catalogs: labels, found: own, to_keep: { everyone: null } };
  let everyone = freshFind(env.earlier?.everyone, at);
  let keep = null;
  if (!everyone && labels.length) {
    everyone = await catalog.find({ text: '' }).catch(() => null);
    if (everyone?.sources.some(source => source.reached)) keep = toKeep(everyone, at);
  }
  return { catalogs: labels, found: everyone ?? null, to_keep: { everyone: keep } };
}

/** Searches the catalogs for `text` (from `page`). Answers { found, to_keep }: `to_keep.own` is the person's last search to keep. */
export async function findConnectors(env, userId, { text, page = null }) {
  const found = await catalogOf(env).find({ text, page });
  return { found, to_keep: { own: toKeep(found, now(env)) } };
}
