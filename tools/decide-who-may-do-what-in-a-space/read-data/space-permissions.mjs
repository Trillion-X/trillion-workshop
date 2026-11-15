// The native consumer supplies fresh semantic record reads and its admitted execution context.
// Neither a caller-provided space object nor its relay argument can replace that authority.
import { spacePermissionMethods, unknown, deadlineOf } from './space-permissions-core.mjs';
import { spaceMemberTypeMethods, SPACE_ACTIONS } from './space-member-types-core.mjs';
export { ruleProblems, problemsWithRules } from './space-permissions-core.mjs';
export { inheritedMemberTypes } from './space-member-types-core.mjs';

export function nativeSpacePermissions(context) {
  const { records, spaceId, resource } = context ?? {};
  if (!records || typeof spaceId !== 'string' || !spaceId || typeof resource !== 'string' || !resource)
    throw unknown('The native space permission context is unavailable.');
  for (const method of ['read', 'member', 'members', 'rules', 'ensureRules', 'community', 'ownMemberTypes', 'accessState'])
    if (typeof records[method] !== 'function') throw unknown(`The record adapter requires ${method}.`);
  for (const method of ['principal', 'current', 'joinedByRules', 'openToEveryone', 'captureSpaceCommit', 'sourceAuthority', 'memberNames', 'spaceChanged'])
    if (typeof context[method] !== 'function') throw unknown(`The native context requires ${method}.`);

  const owner = {
    ...context, ...spacePermissionMethods, ...spaceMemberTypeMethods,
    async admit(id, relay) {
      if (id !== spaceId) throw unknown('The native space context names another space.');
      const principal = await context.principal();
      if (!principal || principal.resource !== resource || principal.relay !== relay)
        throw unknown('The person does not match the admitted native principal.');
      if (await context.current() !== true) throw unknown('The native permission context is no longer current.');
    },
    async isMemberNow(id, relay) { return (await records.member(id, relay))?.state === 'member'; },
    async currentMembers(id) {
      const rows = await records.members(id);
      if (!Array.isArray(rows)) throw unknown('The current members cannot be read.');
      return rows.filter(row => row.state === 'member');
    },
    async communityConfig(id) {
      const row = await records.community(id);
      if (row === null) return null;
      let config;
      try { config = typeof row?.config === 'string' ? JSON.parse(row.config) : row?.config; }
      catch { throw unknown('The community configuration cannot be read.'); }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw unknown('The community configuration cannot be read.');
      if (config.roles !== undefined && (!config.roles || typeof config.roles !== 'object' || Array.isArray(config.roles) ||
          Object.values(config.roles).some(role => !role || typeof role !== 'object' || Array.isArray(role) ||
            role.may !== undefined && !Array.isArray(role.may)))) throw unknown('The community roles cannot be read.');
      return config;
    },
  };
  const freshSpace = async (space, relay) => {
    const id = typeof space === 'string' ? space : space?.id;
    await owner.admit(id, relay);
    const current = await records.read(id);
    if (!current || current.id !== id) throw new Error('You are not a member of that pursuit.');
    return current;
  };
  // Public decisions retry fresh complete evidence, including the direct mayIn/decideInSpace entry points.
  const decide = async (space, relay, action, thing) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await freshSpace(space, relay);
      // Owner privacy precedes even policy reads and snapshots which may include policy.
      if (thing?.shared_here === false) return owner.decideInSpace(current, relay, action, thing);
      const set = await owner.spaceRuleSet(current.id);
      const before = await owner.spaceAccessState(current.id, relay, thing);
      const deadline = deadlineOf(set.rules, Date.now());
      const answer = await owner.decideInSpace(current, relay, action, thing, set);
      await owner.admit(current.id, relay);
      if (before === await owner.spaceAccessState(current.id, relay, thing) && Date.now() < deadline) return answer;
    }
    throw unknown('Space permissions changed while this action was checked. Try again.');
  };
  return Object.freeze({
    allowedInSpace: async (id, relay, action, thing) => {
      await freshSpace(id, relay);
      return owner.allowedInSpace(id, relay, action, thing);
    },
    decideInSpace: decide,
    mayIn: async (space, relay, ids, thing) => Object.fromEntries(await Promise.all(ids.map(async id => [id, (await decide(space, relay, id, thing)).allowed]))),
    mayInSpace: async (space, relay) => Object.fromEntries(await Promise.all(SPACE_ACTIONS.map(async id => [id, (await decide(space, relay, id)).allowed]))),
    readSpaceRules: async ({ space_id, relay }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await freshSpace(space_id, relay);
        const before = await owner.spaceAccessState(space_id, relay);
        const result = await owner.readSpaceRules({ space_id, relay });
        await owner.admit(space_id, relay);
        if (before === await owner.spaceAccessState(space_id, relay)) return result;
      }
      throw unknown('Space permissions changed while these rules were read. Try again.');
    },
    setSpaceRules: async ({ space_id, relay, rules }) => { await freshSpace(space_id, relay); return owner.setSpaceRules({ space_id, relay, rules }); },
    spaceAccessState: async (id, relay, thing) => { await owner.admit(id, relay); return owner.spaceAccessState(id, relay, thing); },
    assertSpaceAccessUnchanged: async (id, relay, before, thing) => { await owner.admit(id, relay); return owner.assertSpaceAccessUnchanged(id, relay, before, thing); },
  });
}
