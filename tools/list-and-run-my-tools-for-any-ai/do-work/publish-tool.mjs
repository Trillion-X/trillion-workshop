// tools/list-and-run-my-tools-for-any-ai/do-work/publish-tool.mjs
//
// publish_tool and unpublish_tool, ported from the old server (src/workshop.mjs publishTool at b6ae0ebf815f:1686 and unpublishTool
// at 1793). A listing is one row of the `marketplace_listings` table in the database the request names (the product side of a
// pursuit, its _for_who_uses_it database). The table is this tool's own fixed name and is made when missing.
//
// Publish reads the saved tool from `saved_tools` in the same database, inside one transaction: the saved row is locked (FOR SHARE)
// until the listing is written, so the saved version cannot change between the check and the write (the old publicationCurrent).
// The listing keeps a copy of the saved files (the old publishBundle: the tool's code for everyone who runs the listing). A listing
// keeps the maker who published it. Only that maker can withdraw it, and another maker cannot take the id while it is kept, even
// after withdrawal. Withdrawal removes the body (the descriptor, the files and the public run terms) and keeps the content-free
// evidence: the maker, the fingerprint and the times (shared-workshop-projection.mjs kept the same evidence and dropped the body).
//
// A lost publish is read from its effect, never by publishing again: publishOutcome answers committed, aborted or unknown from the
// listing row and the saved version (the old publishOutcome). A publish with recover: true only reads.
//
// The public run terms are checked by the kept owner (keep-and-wake's public-app-run-permission.mjs): a public run needs
// show_on_public_site, no price, and a tool that publicRunEligible admits.
//
// Not ported here, and named so no one assumes it is: the price_ref existence check (a published price is a person's offer record,
// read by the funnels-and-offers owner's read-offers.ts; the database it reads from is not yet decided), and the sample run on
// publish (the engine owns sample runs; ai-command-center-70's saved-tool runs will provide it). A publish here records the listing.
import { SAVED_TABLE } from './save-tool.mjs';
import { admitToolDescriptor } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';
import { checkedPublicRunPermission, publicRunEligible } from '../../keep-and-wake-ai-sessions-on-this-computer/src/public-app-run-permission.mjs';

export const LISTINGS_TABLE = 'marketplace_listings';
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${LISTINGS_TABLE} (
  tool_id text PRIMARY KEY,
  maker text NOT NULL,
  status text NOT NULL,
  fingerprint text,
  price_ref text,
  usage_price jsonb,
  show_on_public_site boolean NOT NULL DEFAULT false,
  public_run jsonb,
  body jsonb,
  files bytea,
  first_published_at timestamptz NOT NULL,
  published_at timestamptz,
  withdrawn_at timestamptz
)`;
// A table made before a column existed keeps its old shape, so the columns added since are added here too.
const ADD_COLUMNS_SQL = [
  `ALTER TABLE ${LISTINGS_TABLE} ADD COLUMN IF NOT EXISTS public_run jsonb`,
  `ALTER TABLE ${LISTINGS_TABLE} ADD COLUMN IF NOT EXISTS files bytea`,
];

export class PublishToolError extends Error {}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const MIN_MICROS = 100;

// The same text for the same value whatever the key order, so two terms compare equal when they are equal.
const stable = value => JSON.stringify(value, (key, item) => (object(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item)) ?? 'null';

// Two guards of the old publishTool (src/workshop.mjs:1707 and :942, :1709-1710). A release that needs a newer host version than the
// one publishing it cannot have its sample checked here. A tool whose licence lets it run only in each caller's own sandbox
// cannot be offered to everyone. Both need facts the publisher does not hold on its own, so the caller hands them in: the host
// version (host_version), the host's id (host), the licence classes (licences: id -> { label, allowed_placements }) and the
// placements (placements: id -> { id, executor, reachable_from }). A missing fact is refused, never skipped.
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

const runsOn = (release, hostVersion) => !release.minimum_host_version || compareVersions(hostVersion, release.minimum_host_version) >= 0;

/** Why this host cannot publish the release, or null (the old compatibleRelease check on the row and its earlier releases). */
export function refuseHostVersion(descriptor, hostVersion) {
  const releases = [descriptor, ...(Array.isArray(descriptor.earlier_releases) ? descriptor.earlier_releases : [])];
  if (releases.every(release => !release?.minimum_host_version)) return null;
  if (!nonempty(hostVersion)) return `${descriptor.id} says it needs version ${descriptor.minimum_host_version} or newer, and this publish did not say which host it runs on, so its sample cannot be checked.`;
  if (releases.some(release => release && runsOn(release, hostVersion))) return null;
  return `${descriptor.id} says it needs version ${descriptor.minimum_host_version} or newer, and the host publishing it is ${hostVersion}, so its sample cannot be checked here.`;
}

/** Why this host cannot offer the tool to everyone, or null (the old choosePlacement, then the caller refusal). A tool that names no
 *  licence class is not checked, so it publishes as it did before the guard. */
export function refuseCallerOnly(descriptor, { licences, placements, host } = {}) {
  if (!nonempty(descriptor.licence_class)) return null;
  if (!licences || !placements || !nonempty(host)) return `${descriptor.id}: where it runs is checked from the licence classes, the placements and this host, and they were not given.`;
  const licence = nonempty(descriptor.licence_class) ? licences[descriptor.licence_class] : null;
  if (!licence) return `${descriptor.id} has no known licence class, so it cannot run anywhere yet.`;
  const allowedHere = Array.isArray(licence.allowed_placements) ? licence.allowed_placements : [];
  const allowed = (Array.isArray(descriptor.placements) ? descriptor.placements : []).map(id => placements[id]).filter(place => place && allowedHere.includes(place.id));
  const place = allowed.find(item => Array.isArray(item.reachable_from) && item.reachable_from.includes(host));
  if (!place) return `${descriptor.id} cannot run from here: its licence allows ${allowedHere.join(', ') || 'no placement'}, and none of those can be reached from this service.`;
  if (place.executor === 'caller') return `${descriptor.id}'s licence (${licence.label ?? licence.id}) lets it run only in each caller's own sandbox, so it cannot be offered to everyone from here.`;
  return null;
}

function usagePriceProblem(usage) {
  if (!object(usage) || !Number.isSafeInteger(usage.amount_micros) || usage.amount_micros < MIN_MICROS
    || usage.amount_micros % MIN_MICROS !== 0 || usage.currency !== 'usd') {
    return `usage_price: { "amount_micros": a whole number of at least ${MIN_MICROS} that is a multiple of ${MIN_MICROS}, "currency": "usd" }.`;
  }
  return null;
}

export async function ensureListings(client) {
  await client.query(TABLE_SQL, []);
  for (const sql of ADD_COLUMNS_SQL) await client.query(sql, []);
}

/** Read a listing's state from its effect: committed when this maker's listing holds the asked terms and the saved version is the
 *  one asked; aborted when there is no listing of this maker's; unknown otherwise (never a second publish). */
export async function publishOutcome(input, client) {
  const asked = object(input) ? input : {};
  const { tool_id: toolId, maker } = asked;
  if (!nonempty(toolId) || !nonempty(maker)) return { state: 'unknown' };
  await ensureListings(client);
  const { rows: found } = await client.query(`SELECT * FROM ${LISTINGS_TABLE} WHERE tool_id = $1`, [toolId]);
  if (!found.length || found[0].maker !== maker) return { state: 'aborted' };
  const listing = found[0];
  const { rows: saved } = await client.query(`SELECT fingerprint FROM ${SAVED_TABLE} WHERE id = $1`, [toolId]);
  if (!saved.length || listing.status !== 'published') return { state: 'unknown' };
  const sameTerms = listing.fingerprint === saved[0].fingerprint
    && listing.show_on_public_site === (asked.show_on_public_site ?? false)
    && (listing.price_ref ?? null) === (asked.price_ref ?? null)
    && stable(listing.usage_price ?? null) === stable(asked.usage_price ?? null)
    && stable(listing.public_run ?? null) === stable(asked.public_run ? checkedPublicRunPermission(asked.public_run) : null);
  if (!sameTerms) return { state: 'unknown' };
  return { state: 'committed', listing: { tool_id: listing.tool_id, maker: listing.maker, status: listing.status, fingerprint: listing.fingerprint, published_at: listing.published_at } };
}

/** Publish one saved tool as this maker's listing. input: { tool_id, maker, price_ref | usage_price, show_on_public_site (default false),
 *  public_run ({ runs_per_day, max_input_bytes? }, optional), expected_fingerprint (optional), recover (true reads the outcome only) }. */
export async function publishTool(input, client) {
  const asked = object(input) ? input : {};
  const { tool_id: toolId, maker, price_ref: priceRef, usage_price: usage, expected_fingerprint: expected } = asked;
  const showOnPublicSite = asked.show_on_public_site ?? false;
  if (!nonempty(toolId)) throw new PublishToolError('tool_id: the saved tool to publish, for example "tool:count-words".');
  if (!nonempty(maker)) throw new PublishToolError('maker: the person publishing the tool. Only this maker can withdraw it.');
  if (typeof showOnPublicSite !== 'boolean') throw new PublishToolError('show_on_public_site: true or false (default false).');
  if (asked.recover === true) return { outcome: await publishOutcome(asked, client) };
  if (priceRef !== undefined && usage !== undefined) throw new PublishToolError('Choose either an existing offer price or a price for each completed run.');
  if (usage !== undefined) {
    const problem = usagePriceProblem(usage);
    if (problem) throw new PublishToolError(problem);
  }
  let publicRun;
  try { publicRun = checkedPublicRunPermission(asked.public_run); } catch (error) { throw new PublishToolError(error.message); }
  await ensureListings(client);
  await client.query('BEGIN', []);
  try {
    const { rows: saved } = await client.query(`SELECT id, descriptor, fingerprint, files FROM ${SAVED_TABLE} WHERE id = $1 AND status IS DISTINCT FROM 'deleted' FOR SHARE`, [toolId]);
    if (!saved.length) throw new PublishToolError(`${toolId} is not one of the saved tools in this database. Save it with save_tool first.`);
    const { descriptor, fingerprint, files } = saved[0];
    if (expected !== undefined && expected !== fingerprint) {
      throw new PublishToolError(`${toolId} changed since it was checked for publication. Publish its current version.`);
    }
    if (!(descriptor.verify ?? []).some(check => check?.kind === 'sample-run')) {
      throw new PublishToolError(`${toolId} has no sample-run check, so nobody else can tell it does its job. Add one to verify and save it again.`);
    }
    const admitted = admitToolDescriptor(descriptor);
    if ('refused' in admitted) throw new PublishToolError(admitted.refused.reason);
    const hostRefusal = refuseHostVersion(descriptor, asked.host_version);
    if (hostRefusal) throw new PublishToolError(hostRefusal);
    const placeRefusal = refuseCallerOnly(descriptor, asked);
    if (placeRefusal) throw new PublishToolError(placeRefusal);
    if (publicRun && (!showOnPublicSite || priceRef !== undefined || usage !== undefined
      || !publicRunEligible({ ...descriptor, show_on_public_site: true }))) {
      throw new PublishToolError('public_run is available only for a public-site tool that runs in a no-network container without credentials, external effects, or a visitor price.');
    }
    const { rows: existing } = await client.query(`SELECT maker FROM ${LISTINGS_TABLE} WHERE tool_id = $1 FOR UPDATE`, [toolId]);
    if (existing.length && existing[0].maker !== maker) {
      throw new PublishToolError(`${toolId} belongs to another maker, so this maker cannot publish it.`);
    }
    const { rows } = await client.query(
      `INSERT INTO ${LISTINGS_TABLE} (tool_id, maker, status, fingerprint, price_ref, usage_price, show_on_public_site, public_run, body, files,
         first_published_at, published_at, withdrawn_at)
       VALUES ($1, $2, 'published', $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, now(), now(), NULL)
       ON CONFLICT (tool_id) DO UPDATE SET status = 'published', fingerprint = EXCLUDED.fingerprint, price_ref = EXCLUDED.price_ref,
         usage_price = EXCLUDED.usage_price, show_on_public_site = EXCLUDED.show_on_public_site, public_run = EXCLUDED.public_run,
         body = EXCLUDED.body, files = EXCLUDED.files, published_at = now(), withdrawn_at = NULL
       RETURNING tool_id, maker, status, fingerprint, price_ref, usage_price, show_on_public_site, public_run, published_at`,
      [toolId, maker, fingerprint, priceRef ?? null, usage === undefined ? null : JSON.stringify(usage), showOnPublicSite,
        publicRun ? JSON.stringify(publicRun) : null, JSON.stringify(descriptor), files],
    );
    await client.query('COMMIT', []);
    return { listing: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => {});
    throw error;
  }
}

/** Withdraw this maker's listing: the body and the files go, the content-free evidence (maker, fingerprint, times) stays. */
export async function unpublishTool(input, client) {
  const asked = object(input) ? input : {};
  const { tool_id: toolId, maker } = asked;
  if (!nonempty(toolId)) throw new PublishToolError('tool_id: the published tool to withdraw.');
  if (!nonempty(maker)) throw new PublishToolError('maker: the person who published it.');
  await ensureListings(client);
  await client.query('BEGIN', []);
  try {
    const { rows: found } = await client.query(`SELECT maker, status FROM ${LISTINGS_TABLE} WHERE tool_id = $1 FOR UPDATE`, [toolId]);
    if (!found.length || found[0].maker !== maker || found[0].status !== 'published') {
      throw new PublishToolError(`${toolId} is not a tool this maker published.`);
    }
    const { rows } = await client.query(
      `UPDATE ${LISTINGS_TABLE} SET status = 'withdrawn', body = NULL, files = NULL, public_run = NULL, withdrawn_at = now() WHERE tool_id = $1
       RETURNING tool_id, maker, status, fingerprint, first_published_at, withdrawn_at`,
      [toolId],
    );
    await client.query('COMMIT', []);
    return { evidence: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => {});
    throw error;
  }
}
