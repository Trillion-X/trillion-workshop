// A source chooses one of this account's existing connections. The choice travels in the admitted tool identity,
// never in a copied credential or a process-wide default. Reconnecting the same id is a new incarnation.
const PREFIX = 'tool:bound-connection:';
const text = value => typeof value === 'string' && value.length > 0;
const fail = message => { throw Object.assign(new Error(message), { retryable: false }); };
export const connectionVendor = id => /^service_connection:([^:]+)(?::[^:]+)*$/.exec(String(id ?? ''))?.[1] ?? null;

export function connectionBinding(value) {
  if (!value || !connectionVendor(value.connection_id) || !text(value.connected_at) || !Number.isFinite(Date.parse(value.connected_at)))
    return fail('A source binding needs an exact connection and its connected_at incarnation.');
  if (value.source_id !== undefined && (!text(value.source_id) || !Number.isSafeInteger(value.control_revision) || value.control_revision < 0))
    return fail('A source binding needs its source and nonnegative control revision.');
  if (value.account !== undefined && value.account !== null && !text(value.account)) return fail('A source binding account must be a nonempty provider identity.');
  return { connection_id: value.connection_id, connected_at: value.connected_at,
    ...(value.source_id !== undefined ? { source_id: value.source_id, control_revision: value.control_revision } : {}),
    ...(value.account ? { account: value.account } : {}) };
}

export function requireCurrentConnection(binding, rows) {
  const kept = connectionBinding(binding);
  const row = rows.find(item => item.connection_id === kept.connection_id);
  if (row?.status !== 'connected' || row.can_send === false || row.vendor !== connectionVendor(kept.connection_id) || row.connected_at !== kept.connected_at)
    return fail('The selected source connection is disconnected or changed; check that same connection before continuing.');
  return kept;
}

export function selectSourceConnection(source, earlier, rows, requested) {
  const vendor = source.connects_with?.vendor;
  const chosen = requested ?? earlier?.connection_binding?.connection_id ?? source.connects_with?.connection_id;
  if (requested !== undefined && (!text(requested) || connectionVendor(requested) !== vendor))
    return fail('Choose an existing connection for this source’s vendor.');
  const candidates = rows.filter(item => item.vendor === vendor && item.status === 'connected' && item.can_send !== false);
  const row = chosen ? candidates.find(item => item.connection_id === chosen) : candidates.length === 1 ? candidates[0] : null;
  if (!row) return fail(chosen ? 'The selected source connection is not connected; it was not replaced by another account.'
    : candidates.length ? 'Several accounts are connected. Start this source with connection_id to choose one.'
      : 'This source has no connected account.');
  return connectionBinding({ connection_id: row.connection_id, connected_at: row.connected_at });
}

export function boundToolId(toolId, version, binding) {
  return PREFIX + encodeURIComponent(JSON.stringify([toolId, version, connectionBinding(binding)]));
}
export function boundToolParts(id) {
  if (!String(id).startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(id.slice(PREFIX.length)));
    if (!Array.isArray(value) || value.length !== 3 || !text(value[0]) || value[0].startsWith(PREFIX) || !text(value[1])) throw new Error();
    return { tool_id: value[0], version: value[1], binding: connectionBinding(value[2]) };
  } catch { return fail('The account-bound tool identity is malformed.'); }
}

export function bindAdmittedTool(tool, id, binding) {
  const base = tool?.invoke?.connection_id;
  if (!base || connectionVendor(base) !== connectionVendor(binding.connection_id)) return fail('This tool does not declare the selected connection’s vendor.');
  if (base !== `service_connection:${connectionVendor(base)}` && base !== binding.connection_id)
    return fail('This tool already names a different explicit account.');
  // A concrete named secret can belong to another credential or vendor. Rebind declared fields or exact names
  // of this base connection's fields only; placements and published destination grants stay as admitted.
  const decode = value => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16)));
  const injections = (tool.invoke.credential_injections ?? []).map(item => {
    const explicit = item.secret_name ?? item.vault_key;
    if (!explicit) {
      if (!text(item.field_id)) return fail('A rebound credential must declare its connection field.');
      return item;
    }
    const match = /^service-connection-((?:[0-9a-f]{2})+)-field-((?:[0-9a-f]{2})+)$/.exec(explicit);
    let field;
    try { if (match && decode(match[1]) === base) field = decode(match[2]); } catch {}
    if (!text(field) || item.field_id && item.field_id !== field || item.secret_name && item.vault_key && item.secret_name !== item.vault_key)
      return fail('This tool’s concrete credential references cannot be rebound.');
    const { secret_name, vault_key, ...kept } = item;
    return { ...kept, field_id: field };
  });
  if (tool.invoke.credential_mounts?.length) return fail('This tool’s credential mounts cannot be rebound.');
  return { ...tool, id, invoke: { ...tool.invoke, ...(tool.invoke.credential_injections ? { credential_injections: injections } : {}), connection_id: binding.connection_id, source_connection: binding },
    provenance: { ...tool.provenance, bound_from: tool.id, bound_connection: base, connection_id: binding.connection_id } };
}
