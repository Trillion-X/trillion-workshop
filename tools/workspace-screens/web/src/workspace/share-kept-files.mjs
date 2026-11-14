// Company attachments use the existing mixed sharing owner once for the whole selection.
// Only the kept identities travel here; the uploader owns bytes and the server owns permissions,
// retry identity, ordering and deduplication. Do not send the message until every placement is confirmed.

/**
 * @param {string} spaceId
 * @param {Array<{identity: string, name?: string}>} files
 * @param {(path: string, body: {items: Array<{kind: string, file: string}>, request_key: string}) => Promise<unknown>} post
 * @param {string | null} requestKey
 * @returns {Promise<string[]>}
 */
export async function shareKeptFiles(spaceId, files, post, requestKey = null) {
  if (!Array.isArray(files) || files.some(file => typeof file?.identity !== 'string' || !file.identity.trim())) {
    throw new Error('Trillion could not confirm these files were saved.');
  }
  if (!files.length) return [];
  const key = requestKey ?? crypto.randomUUID();
  const answer = await post(`/work/api/spaces/${encodeURIComponent(spaceId)}/share`, {
    items: files.map(file => ({ kind: 'file', file: file.identity })), request_key: key,
  });
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.placed)
      || answer.count !== files.length || answer.placed.length !== files.length) {
    throw new Error('Trillion could not confirm every file was shared.');
  }
  const shared = [];
  for (const item of answer.placed) {
    if (!item || item.withdrawn === true) throw new Error('One of these files is no longer shared here.');
    if (typeof item.item_id !== 'string' || !item.item_id.trim()) {
      throw new Error('Trillion could not confirm every file was shared.');
    }
    shared.push(item.item_id);
  }
  return [...new Set(shared)];
}
