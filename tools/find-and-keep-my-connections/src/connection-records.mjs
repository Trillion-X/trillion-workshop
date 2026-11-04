// Connected accounts as inspectable records, read from their existing owner.
// These are metadata projections, never another account store or a credential.
// A shared row is resolved through its current offer every time and has its own
// recipient-local reference. A metadata grant never authorizes using an account.

const text = (value, max = 500) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000\r\n]/.test(value) ? value : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownPrefix = 'connection:', sharedPrefix = 'shared-connection:';
const reference = (prefix, id) => {
  if (!text(id, 300)) return null;
  const ref = prefix + encodeURIComponent(id);
  return ref.length <= 500 ? ref : null;
};
const identifier = (prefix, ref) => {
  if (!text(ref) || !ref.startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(ref.slice(prefix.length));
    return reference(prefix, id) === ref ? id : null;
  } catch { return null; }
};

export const connectionRecordRef = id => reference(ownPrefix, id);
export const connectionIdFromRecord = ref => identifier(ownPrefix, ref);
export const sharedConnectionRecordRef = id => reference(sharedPrefix, id);
export const sharedConnectionOfferId = ref => identifier(sharedPrefix, ref);
export const connectionOpenUrl = ref => `/connections?${new URLSearchParams({ show_section: 'accounts', show_row: ref })}`;
export const clampSharedConnectionLimit = (limit = 30) => Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Math.floor(Number(limit)))) : 30;

/** The same projection used by the locked-box listing and its derived index.
 *  Supplying facts here does not cause any read, write, verification or send. */
export function connectionSummaryOf(item, { lastChecked, connectedBy } = {}) {
  if (!item) return null;
  return {
    connection_id: item.id, service: item.serviceName, vendor: item.serviceVendor,
    ...(item.accountLabel ? { account_label: item.accountLabel } : {}),
    status: item.legacyStatus, can_send: item.canSend === true, connected_at: item.connectedAt,
    grant_scopes_known: item.grantScopesKnown === true,
    ...(item.grantScopesKnown === true ? { grant_scopes: item.grantScopes ?? [] } : {}),
    ...(item.capabilityChoices && typeof item.capabilityChoices === 'object' ? { capabilityChoices: item.capabilityChoices } : {}),
    ...(lastChecked ? { last_checked: lastChecked } : {}),
    ...(typeof connectedBy?.app === 'string' ? { connected_by: connectedBy.app } : {}),
  };
}

/** Existing profile/relay facts only. In particular this does not create a
 *  network identity just because somebody opened their Connections screen. */
export function connectionOwner({ relay, name } = {}) {
  return { id: text(relay) ?? 'self', label: text(name, 200) ?? 'You', mine: true };
}

const safeCheck = check => object(check) ? {
  ...(text(check.at, 60) ? { at: check.at } : {}),
  ...(Number.isInteger(check.service_answered) ? { service_answered: check.service_answered } : {}),
} : null;

/** Fields permitted to enter native inspection or a metadata share. No spread
 *  of source objects: new credentials/capabilities cannot silently leak here. */
export function connectionMetadata(row, { owner, recordRef = connectionRecordRef(row?.connection_id) } = {}) {
  if (!row || !recordRef) return null;
  const check = safeCheck(row.last_checked);
  return {
    record_ref: recordRef,
    ...(text(row.connection_id, 500) ? { connection_id: row.connection_id } : {}),
    service: text(row.service, 200) ?? 'Connected account',
    vendor: text(row.vendor, 200) ?? '',
    ...(text(row.account_label, 300) ? { account_label: row.account_label } : {}),
    status: text(row.status, 100) ?? 'unknown',
    ...(text(row.connected_at, 60) ? { connected_at: row.connected_at } : {}),
    ...(text(row.connected_by, 200) ? { connected_by: row.connected_by } : {}),
    ...(check && Object.keys(check).length ? { last_checked: check } : {}),
    owner: { id: text(owner?.id) ?? 'self', label: text(owner?.label, 200) ?? 'Account owner', mine: owner?.mine === true },
  };
}

/** Display flags are derived by the owner, not accepted from shared bodies. */
export function ownedConnectionRow(row, owner) {
  const value = connectionMetadata(row, { owner });
  return value && { ...value, visibility: 'owned', can_manage: !row.carried_by,
    can_send: row.can_send === true,
    ...(row.capabilityChoices && typeof row.capabilityChoices === 'object' && row.status === 'connected'
      && typeof row.connected_at === 'string' ? { capabilityChoices: row.capabilityChoices } : {}),
    grant_scopes_known: row.grant_scopes_known === true,
    ...(row.grant_scopes_known === true ? { grant_scopes: row.grant_scopes ?? [] } : {}),
    ...(text(row.carried_by) ? { carried_by: row.carried_by } : row.carried_by ? { carried_by: true } : {}),
    ...(text(row.last_seen_at, 60) ? { last_seen_at: row.last_seen_at } : {}),
  };
}

/** Called only with the result of readSharedWithMe. Its provenance came from
 *  the authenticated offer; a body cannot choose its owner, permissions, local
 *  record id, or connections to the recipient's private records. */
export function sharedConnectionRow(copy, offerId) {
  const ref = sharedConnectionRecordRef(offerId);
  if (!ref || copy?.kind !== 'connection' || !object(copy.body)) return null;
  const from = copy.provenance;
  const owner = { id: text(from?.owner_ref) ?? `offer:${offerId}`, label: text(from?.from, 200) ?? 'Account owner', mine: false };
  const value = connectionMetadata({ ...copy.body, connection_id: ref }, { owner, recordRef: ref });
  return { ...value, owner, visibility: 'shared', can_manage: false, can_send: false,
    provenance: { ...(text(from?.read_at, 60) ? { read_at: from.read_at } : {}), ...(text(from?.shared_at, 60) ? { shared_at: from.shared_at } : {}) },
  };
}

/** Bounded current grant reads. Only an offered record is read, never a
 *  person's whole account. Failures have no cached title, status or body. The
 *  caller can page through all offered accounts without one unbounded fan-out. */
export async function sharedConnectionPage({ offers, read, after = '', limit = 30 } = {}) {
  if (typeof after !== 'string' || after.length > 500) throw new TypeError('after must be a shared-account cursor.');
  const size = clampSharedConnectionLimit(limit);
  const all = (Array.isArray(offers) ? offers : []).filter(offer => offer?.kind === 'connection' && sharedConnectionRecordRef(offer.offer_id))
    .sort((left, right) => left.offer_id < right.offer_id ? -1 : left.offer_id > right.offer_id ? 1 : 0);
  const remaining = all.filter(offer => offer.offer_id > after), selected = remaining.slice(0, size);
  const connections = [];
  let unavailable = 0;
  for (let at = 0; at < selected.length; at += 6) {
    const batch = selected.slice(at, at + 6);
    const results = await Promise.allSettled(batch.map(offer => Promise.resolve().then(() => read(offer.offer_id))));
    for (let index = 0; index < batch.length; index++) {
      const answer = results[index];
      const row = answer.status === 'fulfilled' ? sharedConnectionRow(answer.value, batch[index].offer_id) : null;
      if (row) connections.push(row); else unavailable++;
    }
  }
  const next = remaining.length > size ? selected.at(-1).offer_id : null;
  return { connections, next, unavailable,
    coverage: { source: 'explicit_shares', complete: !next && unavailable === 0, other_accounts: 'unknown' } };
}

/** The EEAF participation index supplies both endpoints of a relation and
 *  records that directly hold this account. No account metadata row is saved.
 *  Read only local records here: shared account bodies never supply links. */
export function connectionRelations(records, ref, { limit = 24 } = {}) {
  const size = Math.max(1, Math.min(50, Math.floor(limit) || 24));
  const page = records.holdersOf(ref, { limit: size, narrow_model: true });
  const related = new Map();
  for (const holder of page?.holders ?? []) {
    if (!text(holder.id)) continue;
    const type = holder.type ?? records.typeOf(holder.id);
    if (type === 'relation') {
      const edge = records.read(holder.id);
      const other = edge?.subject === ref ? edge.object : edge?.object === ref ? edge.subject : null;
      if (text(other) && other !== ref) related.set(`${other}\n${edge.role}`, { record: other, role: text(edge.role, 200) ?? 'Related', type: records.typeOf(other) ?? '' });
    } else {
      related.set(`${holder.id}\n${holder.role}`, { record: holder.id, role: text(holder.role, 200) ?? 'Contains account', type: text(type, 200) ?? '' });
    }
  }
  return { related: [...related.values()], complete: page?.complete !== false && !page?.next, next: page?.next ?? null };
}

export function connectionState(row) {
  if (row?.status === 'connected') return 'Connected';
  if (row?.status === 'disconnected') return 'Disconnected';
  if (!row?.status || row.status === 'unknown') return 'Unknown';
  if (row.status === 'away') return 'Away';
  return 'Needs attention';
}
