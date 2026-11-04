import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
const fingerprint = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(stable(value)))))}`;
const validText = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError(`${name} must be non-empty text of at most 2048 characters.`);
  return value;
};
const identityKey = identity => {
  if (!object(identity)) throw new TypeError('An original work identity is required.');
  const kind = validText(identity.kind, 'identity.kind');
  const id = validText(identity.id, 'identity.id');
  return { kind, id, key: fingerprint([kind, id]) };
};
const asIdentity = (kind, value) => {
  const id = typeof value === 'string' ? value : value?.id;
  return { kind, id: validText(id, `${kind}.id`) };
};
const resourceOf = value => {
  if (!object(value)) throw new TypeError('An addressed executing resource is required.');
  return { owner: validText(value.owner, 'resource.owner'), resource: validText(value.resource, 'resource.resource') };
};
const resourceJson = value => JSON.stringify([value.owner, value.resource]);
const parseResource = value => { const [owner, resource] = JSON.parse(value); return { owner, resource }; };
const bounded = (rows, name) => { if (rows.length > 1000) throw new TypeError(`${name} may contain at most 1000 entries.`); return rows; };

/** Durable affinity for stable task/input/list identities and their atomic relationship groups.
 * `resources` is the legacy current candidate set. `selectResource(key)` may instead
 * synchronously select one addressed resource without materializing that set. Existing bindings always win. */
export function originalWorkResourceSelection({ sql, transaction, owner, generation = 'initial', currentGeneration = () => generation, resources, selectResource }) {
  if (!sql || typeof sql.exec !== 'function' || typeof transaction !== 'function') throw new TypeError('A durable SQL owner and transaction function are required.');
  validText(owner, 'owner'); validText(generation, 'generation');
  if (typeof currentGeneration !== 'function') throw new TypeError('currentGeneration must be callable.');
  if (selectResource !== undefined && typeof selectResource !== 'function') throw new TypeError('selectResource must be callable.');
  sql.exec(`CREATE TABLE IF NOT EXISTS original_work_resource_bindings (
    owner TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL, identity_key TEXT NOT NULL,
    identity_json TEXT NOT NULL, group_key TEXT, resource_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'bound',
    tombstone_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(owner,generation,kind,identity_key))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS original_work_resource_groups (
    owner TEXT NOT NULL, generation TEXT NOT NULL, group_key TEXT NOT NULL, group_json TEXT NOT NULL,
    resource_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'bound', tombstone_json TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY(owner,generation,group_key))`);

  const assertGeneration = requested => {
    const asked = validText(requested ?? generation, 'generation');
    if (asked !== generation || currentGeneration() !== generation) throw fail('resource_selection_generation_changed', 'The resource-selection generation changed; resolve against the current generation.', { expected: currentGeneration(), received: asked });
    return asked;
  };
  const candidates = supplied => {
    const rows = supplied ?? (typeof resources === 'function' ? resources() : resources);
    if (!Array.isArray(rows) || rows.length === 0) throw fail('resource_selection_unavailable', 'No executing resources are available for original work.');
    bounded(rows, 'resources');
    const unique = new Map(rows.map(row => {
      const resource = resourceOf(row);
      if (resource.owner !== owner) throw fail('resource_selection_owner_mismatch', 'A private original-work selector can only route to resources owned by the same account.', { expected_owner: owner, received_owner: resource.owner });
      return [resourceJson(resource), resource];
    }));
    return [...unique.values()].sort((a, b) => resourceJson(a).localeCompare(resourceJson(b)));
  };
  const choose = (key, pool) => pool[Number.parseInt(fingerprint(key).slice(3, 15), 16) % pool.length];
  const chooseResource = (key, supplied) => {
    if (selectResource) {
      const selected = selectResource(key);
      if (selected == null) throw fail('resource_selection_unavailable', 'No executing resources are available for original work.');
      const resource = resourceOf(selected);
      if (resource.owner !== owner) throw fail('resource_selection_owner_mismatch', 'A private original-work selector can only route to resources owned by the same account.', { expected_owner: owner, received_owner: resource.owner });
      return resource;
    }
    return choose(key, candidates(supplied));
  };
  const fetchGroup = (key, gen) => sql.exec('SELECT * FROM original_work_resource_groups WHERE owner=? AND generation=? AND group_key=?', owner, gen, key).toArray()[0] ?? null;
  const fetchBinding = (identity, gen) => sql.exec('SELECT * FROM original_work_resource_bindings WHERE owner=? AND generation=? AND kind=? AND identity_key=?', owner, gen, identity.kind, identity.key).toArray()[0] ?? null;
  const decodeBound = (row, what) => {
    if (row.state === 'tombstone') throw fail('resource_selection_tombstoned', `The ${what} has been tombstoned and cannot be rebound.`, { tombstone: row.tombstone_json ? JSON.parse(row.tombstone_json) : null });
    if (row.state !== 'bound') throw fail('resource_selection_corrupt', `The ${what} has an unknown durable state.`);
    return parseResource(row.resource_json);
  };
  const timestamp = () => new Date().toISOString();

  function bind({ identities, group = null, resource, generation: requestedGeneration }) {
    const gen = assertGeneration(requestedGeneration), selected = resourceOf(resource);
    if (selected.owner !== owner) throw fail('resource_selection_owner_mismatch', 'A private original-work selector cannot bind another account\'s resource.', { expected_owner: owner, received_owner: selected.owner });
    if (!Array.isArray(identities) || !identities.length) throw new TypeError('At least one original work identity is required.');
    const normalized = identities.map(identityKey);
    bounded(normalized, 'identities');
    if (new Set(normalized.map(row => row.key)).size !== normalized.length) throw new TypeError('Duplicate identities are not allowed in one binding.');
    const groupKey = group == null ? null : fingerprint(validText(group, 'group'));
    return transaction(() => {
      const repeated = normalized.every(identity => {
        const prior = fetchBinding(identity, gen);
        return prior && prior.state === 'bound' && prior.resource_json === resourceJson(selected) && (prior.group_key ?? null) === groupKey;
      }) && (!groupKey || Boolean(fetchGroup(groupKey, gen)));
      if (groupKey) {
        const priorGroup = fetchGroup(groupKey, gen);
        if (priorGroup && resourceJson(decodeBound(priorGroup, 'relationship group')) !== resourceJson(selected)) throw fail('resource_selection_conflict', 'This atomic relationship group is already assigned to another resource; explicit recovery is required.', { group, existing: parseResource(priorGroup.resource_json), requested: selected });
      }
      for (const identity of normalized) {
        const prior = fetchBinding(identity, gen);
        if (prior && (resourceJson(decodeBound(prior, 'identity')) !== resourceJson(selected) || (prior.group_key ?? null) !== null && (prior.group_key ?? null) !== groupKey)) throw fail('resource_selection_conflict', 'An original work identity is already bound incompatibly; explicit recovery is required.', { identity: { kind: identity.kind, id: identity.id }, existing: parseResource(prior.resource_json), requested: selected });
      }
      const at = timestamp();
      if (groupKey) sql.exec('INSERT OR IGNORE INTO original_work_resource_groups VALUES (?,?,?,?,?,?,?,?)', owner, gen, groupKey, JSON.stringify(group), resourceJson(selected), 'bound', null, at);
      for (const identity of normalized) {
        const prior = fetchBinding(identity, gen);
        if (prior && prior.group_key == null && groupKey) sql.exec('UPDATE original_work_resource_bindings SET group_key=? WHERE owner=? AND generation=? AND kind=? AND identity_key=?', groupKey, owner, gen, identity.kind, identity.key);
        else sql.exec('INSERT OR IGNORE INTO original_work_resource_bindings VALUES (?,?,?,?,?,?,?,?,?,?)', owner, gen, identity.kind, identity.key, JSON.stringify({ kind: identity.kind, id: identity.id }), groupKey, resourceJson(selected), 'bound', null, at);
      }
      return { generation: gen, resource: selected, group: group == null ? null : groupKey, identities: normalized.map(({ kind, id }) => ({ kind, id })), repeated };
    });
  }

  function resolveWithinTransaction({ identities, group = null, generation: requestedGeneration, resources: suppliedResources, create = true }) {
    const gen = assertGeneration(requestedGeneration);
    if (!Array.isArray(identities) || !identities.length) throw new TypeError('At least one original work identity is required.');
    const normalized = identities.map(identityKey);
    bounded(normalized, 'identities');
    if (new Set(normalized.map(row => row.key)).size !== normalized.length) throw new TypeError('Duplicate identities are not allowed in one resolution.');
    const groupKey = group == null ? null : fingerprint(validText(group, 'group'));
    {
      const priorGroup = groupKey ? fetchGroup(groupKey, gen) : null;
      const bound = normalized.map(identity => ({ identity, row: fetchBinding(identity, gen) })).filter(entry => entry.row);
      if (create !== true && bound.length !== normalized.length) throw fail('resource_selection_unbound', 'This original identity has no native resource binding; legacy-owned data requires an explicit migration bind before native routing.', { group: group ?? null, identities: normalized.filter(identity => !fetchBinding(identity, gen)).map(({ kind, id }) => ({ kind, id })) });
      const known = [priorGroup, ...bound.map(entry => entry.row)].filter(Boolean).map(row => ({ row, resource: decodeBound(row, row === priorGroup ? 'relationship group' : 'identity') }));
      const distinct = new Map(known.map(entry => [resourceJson(entry.resource), entry.resource]));
      if (distinct.size > 1) throw fail('resource_selection_conflict', 'Related original work identities are already split across resources; explicit recovery is required.', { group, resources: [...distinct.values()] });
      if (distinct.size === 0 && create !== true) throw fail('resource_selection_unbound', 'This original identity has no native resource binding; legacy-owned data requires an explicit migration bind before native routing.', { group: group ?? null, identities: normalized.map(({ kind, id }) => ({ kind, id })) });
      const selected = distinct.values().next().value ?? chooseResource([owner, gen, groupKey ?? normalized.map(row => row.key).sort()], suppliedResources);
      // A group's existing route may have been removed from the candidate set. Preserve affinity and let the owner report
      // availability; silently remapping would split references already stored there.
      if (groupKey && !priorGroup) {
        const at = timestamp();
        sql.exec('INSERT INTO original_work_resource_groups VALUES (?,?,?,?,?,?,?,?)', owner, gen, groupKey, JSON.stringify(group), resourceJson(selected), 'bound', null, at);
      }
      for (const identity of normalized) {
        const prior = fetchBinding(identity, gen);
        if (prior) {
          if ((prior.group_key ?? null) !== groupKey && groupKey !== null) {
            if (prior.group_key == null) sql.exec('UPDATE original_work_resource_bindings SET group_key=? WHERE owner=? AND generation=? AND kind=? AND identity_key=?', groupKey, owner, gen, identity.kind, identity.key);
            else throw fail('resource_selection_conflict', 'An identity is already part of a different atomic relationship group; explicit recovery is required.', { identity: { kind: identity.kind, id: identity.id } });
          }
          continue;
        }
        sql.exec('INSERT INTO original_work_resource_bindings VALUES (?,?,?,?,?,?,?,?,?,?)', owner, gen, identity.kind, identity.key, JSON.stringify({ kind: identity.kind, id: identity.id }), groupKey, resourceJson(selected), 'bound', null, timestamp());
      }
      return { generation: gen, resource: selected, group: groupKey, identities: normalized.map(({ kind, id }) => ({ kind, id })) };
    }
  }

  function resolve({ identities, group = null, generation: requestedGeneration, resources: suppliedResources, create = true }) {
    return transaction(() => resolveWithinTransaction({ identities, group, generation: requestedGeneration, resources: suppliedResources, create }));
  }

  function tombstone({ identities = [], group = null, reason, generation: requestedGeneration }) {
    const gen = assertGeneration(requestedGeneration), note = { reason: validText(reason, 'reason'), at: timestamp() };
    if (!Array.isArray(identities)) throw new TypeError('identities must be an array.');
    const normalized = identities.map(identityKey), groupKey = group == null ? null : fingerprint(validText(group, 'group'));
    bounded(normalized, 'identities');
    if (!normalized.length && !groupKey) throw new TypeError('An identity or relationship group is required to tombstone.');
    return transaction(() => {
      let changed = 0;
      for (const identity of normalized) {
        const prior = fetchBinding(identity, gen);
        if (!prior) {
          sql.exec('INSERT INTO original_work_resource_bindings VALUES (?,?,?,?,?,?,?,?,?,?)', owner, gen, identity.kind, identity.key,
            JSON.stringify({ kind: identity.kind, id: identity.id }), groupKey, '[]', 'tombstone', JSON.stringify(note), note.at);
          changed++;
          continue;
        }
        if (prior.state === 'tombstone') continue;
        sql.exec("UPDATE original_work_resource_bindings SET state='tombstone',tombstone_json=? WHERE owner=? AND generation=? AND kind=? AND identity_key=?", JSON.stringify(note), owner, gen, identity.kind, identity.key); changed++;
      }
      if (groupKey) {
        const prior = fetchGroup(groupKey, gen);
        if (prior && prior.state !== 'tombstone') { sql.exec("UPDATE original_work_resource_groups SET state='tombstone',tombstone_json=? WHERE owner=? AND generation=? AND group_key=?", JSON.stringify(note), owner, gen, groupKey); changed++; }
        else if (!prior) { sql.exec('INSERT INTO original_work_resource_groups VALUES (?,?,?,?,?,?,?,?)', owner, gen, groupKey, JSON.stringify(group), '[]', 'tombstone', JSON.stringify(note), note.at); changed++; }
        const members = sql.exec('SELECT kind,identity_key FROM original_work_resource_bindings WHERE owner=? AND generation=? AND group_key=? AND state=?', owner, gen, groupKey, 'bound').toArray();
        for (const member of members) {
          sql.exec("UPDATE original_work_resource_bindings SET state='tombstone',tombstone_json=? WHERE owner=? AND generation=? AND kind=? AND identity_key=?", JSON.stringify(note), owner, gen, member.kind, member.identity_key);
          changed++;
        }
      }
      return { generation: gen, tombstoned: changed, note };
    });
  }

  function resolveWork({ task, inputs = [], lists = [], relationships = [], generation: requestedGeneration, resources: suppliedResources, create = true }) {
    const taskIdentity = asIdentity('original-task', task);
    if (!Array.isArray(inputs) || !Array.isArray(lists) || !Array.isArray(relationships)) throw new TypeError('inputs, lists and relationships must be arrays.');
    bounded(inputs, 'inputs'); bounded(lists, 'lists'); bounded(relationships, 'relationships');
    return transaction(() => {
      const relationshipRoutes = relationships.map(row => {
        if (!object(row) || !Array.isArray(row.identities) || !row.identities.length) throw new TypeError('Each relationship requires an id and related identities.');
        const id = validText(row.id, 'relationship.id');
        return { id, ...resolveWithinTransaction({ identities: bounded(row.identities, 'relationship identities'), group: id, generation: requestedGeneration, resources: suppliedResources, create }).resource };
      });
      const routes = {
        task: resolveWithinTransaction({ identities: [taskIdentity], generation: requestedGeneration, resources: suppliedResources, create }).resource,
        inputs: inputs.map(value => {
          const identity = asIdentity('input', value);
          return { id: identity.id, ...resolveWithinTransaction({ identities: [identity], generation: requestedGeneration, resources: suppliedResources, create }).resource };
        }),
        lists: lists.map(value => {
          const identity = asIdentity('list', value);
          return { id: identity.id, ...resolveWithinTransaction({ identities: [identity], generation: requestedGeneration, resources: suppliedResources, create }).resource };
        }),
        relationships: relationshipRoutes,
      };
      return { generation: assertGeneration(requestedGeneration), ...routes };
    });
  }

  return Object.freeze({ bind, resolve, resolveWork, tombstone, generation: () => assertGeneration() });
}
