// The owning record's DATA describes its collection. Callers choose a member's
// stable identity, never a path into somebody else's record or a replacement
// aggregate. A restore preserves every current sibling and the record metadata.
// A collection is { path, identity_field } (path [] when the record itself is the
// list of members) or { whole: <member id> } when the whole record is one member
// (a screen's own arrangement): src/workspace-record-history.json declares which. A collection that may hold one id
// more than once (`duplicate_members: "last"`) versions its last copy; any other refuses an ambiguous id.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wholeOf = policy => (typeof policy?.collection?.whole === 'string' && policy.collection.whole.length > 0 ? policy.collection.whole : null);
const safeKey = key => typeof key === 'string' && key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key);

export function revisionPolicyFor(address, policies) {
  if (typeof address !== 'string') return null;
  return policies.find(policy => policy?.address === address || (typeof policy?.prefix === 'string' && policy.prefix.length > 0 && address.startsWith(policy.prefix))) ?? null;
}

function collectionOf(value, policy) {
  const { path, identity_field: identityField } = policy?.collection ?? {};
  if (!Array.isArray(path) || path.length > 16 || !path.every(safeKey) || !safeKey(identityField)) {
    throw new Error('This record does not declare a restorable member collection.');
  }
  let at = value;
  for (const key of path) {
    if (!object(at) || !Object.hasOwn(at, key)) throw new Error('The saved member collection is unavailable.');
    at = at[key];
  }
  if (!Array.isArray(at)) throw new Error('The saved member collection is invalid.');
  return { items: at, path, identityField };
}

export function revisionMember(value, policy, scopeId) {
  if (typeof scopeId !== 'string' || !scopeId.trim()) throw new Error('Choose the saved member to restore.');
  const whole = wholeOf(policy);
  if (whole) return scopeId === whole && value !== null && value !== undefined ? value : null;
  const collection = collectionOf(value, policy);
  const matches = collection.items.filter(item => object(item) && item[collection.identityField] === scopeId);
  if (matches.length > 1 && policy.collection.duplicate_members !== 'last') throw new Error('The saved member identity is ambiguous.');
  return matches.at(-1) ?? null;
}

export function revisionMembers(value, policy) {
  const whole = wholeOf(policy);
  if (whole) return new Map(value === null || value === undefined ? [] : [[whole, value]]);
  const collection = collectionOf(value, policy);
  const members = new Map();
  for (const item of collection.items) {
    if (!object(item) || !safeKey(item[collection.identityField])) continue;
    const id = item[collection.identityField];
    if (members.has(id) && policy.collection.duplicate_members !== 'last') throw new Error('The saved member identity is ambiguous.');
    members.set(id, item);
  }
  return members;
}

export function restoreRevisionMember(current, savedMember, policy, scopeId) {
  const identityField = policy?.collection?.identity_field;
  if (wholeOf(policy) ? scopeId !== wholeOf(policy) || savedMember === null || savedMember === undefined
    : !object(savedMember) || !safeKey(identityField) || savedMember[identityField] !== scopeId) throw new Error('That version does not contain this member.');
  const member = savedMember;
  if (wholeOf(policy)) return structuredClone(member);
  const next = structuredClone(current);
  const collection = collectionOf(next, policy);
  const matches = collection.items.flatMap((item, index) => object(item) && item[collection.identityField] === scopeId ? [index] : []);
  if (matches.length > 1 && policy.collection.duplicate_members !== 'last') throw new Error('The current member identity is ambiguous.');
  if (matches.length) collection.items[matches.at(-1)] = structuredClone(member);
  else collection.items.push(structuredClone(member));
  return next;
}

/** `current` without the member `scopeId` (null when the whole record was that member); siblings and metadata stay. */
export function removeRevisionMember(current, policy, scopeId) {
  if (wholeOf(policy)) return null;
  const next = structuredClone(current);
  const collection = collectionOf(next, policy);
  const kept = collection.items.filter(item => !(object(item) && item[collection.identityField] === scopeId));
  if (kept.length === collection.items.length) throw new Error('That member is already unavailable.');
  if (!collection.path.length) return kept;
  let at = next;
  for (const key of collection.path.slice(0, -1)) at = at[key];
  at[collection.path.at(-1)] = kept;
  return next;
}
