// tools/list-and-run-my-tools-for-any-ai/do-work/publish-screen-rows.mjs
//
// The step that published the catalogue screens to the Marketplace, ported from the held
// tools/show-my-screens-from-a-catalogue-of-reads-and-layouts/from-an-older-version/scripts/publish-marketplace-screens.mjs
// (which saved each row, then published it, as the publisher account, after each release). It is the same two steps in the
// current owners: each row goes through saveTool (save-tool.mjs), then publishTool (publish-tool.mjs), in the database the
// client names. The rows are the catalogue's records (tools/show-my-screens-from-a-catalogue-of-reads-and-layouts/records/
// marketplace-screens.json); the caller reads them and names the maker. No key and no address: the client is the database.
//
// Per row the result is { id, saved, published } and, when a step fails, the first line of its error, as the held script
// answered. One refused row does not stop the others. Nothing is published unless the caller calls this.
import { saveTool } from './save-tool.mjs';
import { publishTool } from './publish-tool.mjs';

export class PublishScreenRowsError extends Error {}

const nonempty = value => typeof value === 'string' && value.trim() !== '';
const firstLine = error => String(error?.message ?? error).split('\n')[0];

/**
 * Save then publish each catalogue row as `maker`. The publish guards need the host's version (hostVersion), its id (host),
 * and the licence classes and placements the rows name (licences, placements), as publishTool does. Returns
 * [{ id, saved, published, error? }] in row order.
 */
export async function publishScreenRows({ rows, maker, client, host, hostVersion, licences, placements } = {}) {
  if (!Array.isArray(rows)) throw new PublishScreenRowsError('rows: the catalogue rows, an array of ai-tool-descriptor objects.');
  if (!nonempty(maker)) throw new PublishScreenRowsError('maker: the person publishing the rows. Only this maker can withdraw them.');
  const results = [];
  for (const descriptor of rows) {
    try {
      await saveTool({ descriptor }, client);
      await publishTool({ tool_id: descriptor.id, maker, host, host_version: hostVersion, licences, placements }, client);
      results.push({ id: descriptor.id, saved: true, published: true });
    } catch (error) {
      results.push({ id: descriptor.id, saved: false, published: false, error: firstLine(error) });
    }
  }
  return results;
}
