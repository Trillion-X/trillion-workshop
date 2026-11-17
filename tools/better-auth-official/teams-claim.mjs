// The teams a person belongs to, carried in every pass this tool signs (https://www.better-auth.com/docs/plugins/organization, teams).
// settings.teams names the claim (`claim`: the array of team ids a pass carries) and how many ids one pass may carry (`most`: a
// pass is read whole by every computer, which refuses one past its token size, so a person in more teams than that carries the
// newest `most` of them, never a pass the computer would refuse). Which teams a person is in is the organization plugin's `teamMember`
// rows; nothing else keeps it. A person taken out of a team is still in the pass they already hold until it expires
// (settings.mcp.access_token_seconds for an AI's access token), and in no pass signed after.

/** The ids of the teams `userId` is in, newest first, at most `named.most` of them, as the organization plugin's own adapter reads them. */
export async function teamIdsOf(named, adapterOf, userId) {
  const adapter = await adapterOf();
  const rows = await adapter.findMany({
    model: 'teamMember', where: [{ field: 'userId', value: userId }], sortBy: { field: 'createdAt', direction: 'desc' }, limit: named.most,
  });
  return rows.map(row => row.teamId);
}

/** The claim a pass carries for `userId`: `{[claim]: [team ids]}`; the claim is always present, empty for a person in no team. */
export async function teamClaim(named, teamIds, userId) {
  return { [named.claim]: await teamIds(userId) };
}
