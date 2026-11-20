// tools/list-and-run-my-tools-for-any-ai/do-work/publish-tool.mjs
//
// publish_tool and unpublish_tool, ported from the old server (src/workshop.mjs publishTool at b6ae0ebf815f:1686 and unpublishTool
// at 1793). A listing is one row of the `marketplace_listings` table in the database the request names (the product side of a
// pursuit, its _for_who_uses_it database). The table is this tool's own fixed name and is made when missing.
//
// Publish reads the saved tool from `saved_tools` in the same database, inside one transaction: the saved row is locked (FOR SHARE)
// until the listing is written, so the saved version cannot change between the check and the write (the old publicationCurrent).
// A listing keeps the maker who published it. Only that maker can withdraw it, and another maker cannot take the id while it is
// kept, even after withdrawal. Withdrawal removes the body (the descriptor) and keeps the content-free evidence: the maker, the
// fingerprint and the times (shared-workshop-projection.mjs kept the same evidence and dropped the public body).
//
// Not ported here, and named so no one assumes it is: the price_ref existence check (the old code read published prices from the
// shared store), the sample run on publish (the engine owns sample runs), the public_run permission and the bundle publish for
// container and screen tools. A publish here records the listing; it does not run the sample.
import { SAVED_TABLE } from './save-tool.mjs';
import { admitToolDescriptor } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';

export const LISTINGS_TABLE = 'marketplace_listings';
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${LISTINGS_TABLE} (
  tool_id text PRIMARY KEY,
  maker text NOT NULL,
  status text NOT NULL,
  fingerprint text,
  price_ref text,
  usage_price jsonb,
  show_on_public_site boolean NOT NULL DEFAULT false,
  body jsonb,
  first_published_at timestamptz NOT NULL,
  published_at timestamptz,
  withdrawn_at timestamptz
)`;

export class PublishToolError extends Error {}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const MIN_MICROS = 100;

function usagePriceProblem(usage) {
  if (!object(usage) || !Number.isSafeInteger(usage.amount_micros) || usage.amount_micros < MIN_MICROS
    || usage.amount_micros % MIN_MICROS !== 0 || usage.currency !== 'usd') {
    return `usage_price: { "amount_micros": a whole number of at least ${MIN_MICROS} that is a multiple of ${MIN_MICROS}, "currency": "usd" }.`;
  }
  return null;
}

/** Publish one saved tool as this maker's listing. input: { database-side client, tool_id, maker, price_ref | usage_price,
 *  show_on_public_site (default false), expected_fingerprint (optional: refuse if the saved version is not this one) }. */
export async function publishTool(input, client) {
  const asked = object(input) ? input : {};
  const { tool_id: toolId, maker, price_ref: priceRef, usage_price: usage, expected_fingerprint: expected } = asked;
  const showOnPublicSite = asked.show_on_public_site ?? false;
  if (!nonempty(toolId)) throw new PublishToolError('tool_id: the saved tool to publish, for example "tool:count-words".');
  if (!nonempty(maker)) throw new PublishToolError('maker: the person publishing the tool. Only this maker can withdraw it.');
  if (typeof showOnPublicSite !== 'boolean') throw new PublishToolError('show_on_public_site: true or false (default false).');
  if (priceRef !== undefined && usage !== undefined) throw new PublishToolError('Choose either an existing offer price or a price for each completed run.');
  if (usage !== undefined) {
    const problem = usagePriceProblem(usage);
    if (problem) throw new PublishToolError(problem);
  }
  await client.query(TABLE_SQL, []);
  await client.query('BEGIN', []);
  try {
    const { rows: saved } = await client.query(`SELECT id, descriptor, fingerprint FROM ${SAVED_TABLE} WHERE id = $1 FOR SHARE`, [toolId]);
    if (!saved.length) throw new PublishToolError(`${toolId} is not one of the saved tools in this database. Save it with save_tool first.`);
    const { descriptor, fingerprint } = saved[0];
    if (expected !== undefined && expected !== fingerprint) {
      throw new PublishToolError(`${toolId} changed since it was checked for publication. Publish its current version.`);
    }
    if (!(descriptor.verify ?? []).some(check => check?.kind === 'sample-run')) {
      throw new PublishToolError(`${toolId} has no sample-run check, so nobody else can tell it does its job. Add one to verify and save it again.`);
    }
    const admitted = admitToolDescriptor(descriptor);
    if ('refused' in admitted) throw new PublishToolError(admitted.refused.reason);
    const { rows: existing } = await client.query(`SELECT maker FROM ${LISTINGS_TABLE} WHERE tool_id = $1 FOR UPDATE`, [toolId]);
    if (existing.length && existing[0].maker !== maker) {
      throw new PublishToolError(`${toolId} belongs to another maker, so this maker cannot publish it.`);
    }
    const { rows } = await client.query(
      `INSERT INTO ${LISTINGS_TABLE} (tool_id, maker, status, fingerprint, price_ref, usage_price, show_on_public_site, body,
         first_published_at, published_at, withdrawn_at)
       VALUES ($1, $2, 'published', $3, $4, $5::jsonb, $6, $7::jsonb, now(), now(), NULL)
       ON CONFLICT (tool_id) DO UPDATE SET status = 'published', fingerprint = EXCLUDED.fingerprint, price_ref = EXCLUDED.price_ref,
         usage_price = EXCLUDED.usage_price, show_on_public_site = EXCLUDED.show_on_public_site, body = EXCLUDED.body,
         published_at = now(), withdrawn_at = NULL
       RETURNING tool_id, maker, status, fingerprint, price_ref, usage_price, show_on_public_site, published_at`,
      [toolId, maker, fingerprint, priceRef ?? null, usage === undefined ? null : JSON.stringify(usage), showOnPublicSite, JSON.stringify(descriptor)],
    );
    await client.query('COMMIT', []);
    return { listing: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => {});
    throw error;
  }
}

/** Withdraw this maker's listing: the body goes, the content-free evidence (maker, fingerprint, times) stays. */
export async function unpublishTool(input, client) {
  const asked = object(input) ? input : {};
  const { tool_id: toolId, maker } = asked;
  if (!nonempty(toolId)) throw new PublishToolError('tool_id: the published tool to withdraw.');
  if (!nonempty(maker)) throw new PublishToolError('maker: the person who published it.');
  await client.query(TABLE_SQL, []);
  await client.query('BEGIN', []);
  try {
    const { rows: found } = await client.query(`SELECT maker, status FROM ${LISTINGS_TABLE} WHERE tool_id = $1 FOR UPDATE`, [toolId]);
    if (!found.length || found[0].maker !== maker || found[0].status !== 'published') {
      throw new PublishToolError(`${toolId} is not a tool this maker published.`);
    }
    const { rows } = await client.query(
      `UPDATE ${LISTINGS_TABLE} SET status = 'withdrawn', body = NULL, withdrawn_at = now() WHERE tool_id = $1
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
