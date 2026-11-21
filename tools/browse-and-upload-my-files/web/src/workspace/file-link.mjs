// Makes one link to a file the person keeps: the files tool's share_file answers an address that opens the file for
// `seconds` without other credentials (src/account_files/mod.rs share_file: { url, share, identity, name, expires_at }).
// The link is shown once by the sheet (file-link.tsx); this module only asks for it and checks the answer.

/**
 * @param {(op: string, input: object) => Promise<any>} change the files door's change call (api.ts files.change)
 * @param {{ identity: string, seconds: number }} asked
 * @returns {Promise<{ url: string, expires_at: string | null }>}
 */
export async function makeFileLink(change, { identity, seconds }) {
  if (typeof identity !== 'string' || !identity.trim()) throw new Error('A file is needed to make its link.');
  const answer = await change('share_file', { name_or_identity: identity, seconds });
  if (typeof answer?.url !== 'string' || !answer.url.startsWith('https://')) throw new Error('The link answer has no address.');
  return { url: answer.url, expires_at: typeof answer.expires_at === 'string' ? answer.expires_at : null };
}
