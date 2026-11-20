// tools/list-and-run-my-tools-for-any-ai/do-work/delete-tool.mjs
//
// delete_tool, ported from the old server (src/workshop.mjs deleteTool at b6ae0ebf815f:1668). It marks one saved tool deleted in
// `saved_tools` of the database the request names: the row keeps its id and gets status 'deleted' and deleted_at, as the old
// deleteTool did. A tool this maker still has published is refused until it is withdrawn with unpublish_tool, as before.
// Nothing else is removed: a listing's content-free evidence and the other makers' listings are not touched here.
//
// Publish and save both skip a deleted row (publish-tool.mjs reads only live saved tools; save-tool.mjs revives the id on a new
// save). The listing lookup and its table come from publish-tool.mjs, the owner of marketplace_listings.
import { SAVED_TABLE, ensureSavedTable } from './save-tool.mjs';
import { LISTINGS_TABLE, ensureListings } from './publish-tool.mjs';

export class DeleteToolError extends Error {}

const nonempty = value => typeof value === 'string' && value.trim() !== '';

/** Delete one saved tool, given { tool_id, maker }. Returns { tool_id, deleted: true }. */
export async function deleteTool(input, client) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const { tool_id: toolId, maker } = asked;
  if (!nonempty(toolId)) throw new DeleteToolError('tool_id: the saved tool to delete, for example "tool:count-words".');
  if (!nonempty(maker)) throw new DeleteToolError('maker: the person deleting the tool.');
  await ensureSavedTable(client);
  await ensureListings(client);
  await client.query('BEGIN', []);
  try {
    const { rows: saved } = await client.query(`SELECT id FROM ${SAVED_TABLE} WHERE id = $1 AND status IS DISTINCT FROM 'deleted' FOR UPDATE`, [toolId]);
    if (!saved.length) throw new DeleteToolError(`${toolId} is not one of this database's saved tools.`);
    const { rows: listed } = await client.query(`SELECT maker, status FROM ${LISTINGS_TABLE} WHERE tool_id = $1 FOR SHARE`, [toolId]);
    if (listed.length && listed[0].maker === maker && listed[0].status === 'published') {
      throw new DeleteToolError(`${toolId} is published. Withdraw it with unpublish_tool first; then it can be deleted.`);
    }
    await client.query(`UPDATE ${SAVED_TABLE} SET status = 'deleted', deleted_at = now() WHERE id = $1`, [toolId]);
    await client.query('COMMIT', []);
    return { tool_id: toolId, deleted: true };
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => {});
    throw error;
  }
}
