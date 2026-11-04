// parts/timed-action/do-work/write-scheduled-action-record.ts (ported unchanged from bitfield-packages packages/timed-action/do-work)
function write(address, path, payload) {
  return { address, path, payload };
}

function graphAddress(kind, id) {
  return `timed-action.scheduled-action.${kind}::${id}`;
}

// Every graph record is written at a NARROWLY-queryable current-item kind path so
// find-current-items can return it (in:"scheduled-action-<role>" -> path
// ['current-item','scheduled-action-<role>']; find_query.rs current_item_kind_path_prefix).
// A record written at any other first path segment is invisible to find-current-items.
// Each payload also self-describes its `kind` so a caller reading a mixed stream can
// separate roles without re-deriving them from the address.
function graphPath(role) {
  return ['current-item', `scheduled-action-${role}`];
}
function graphKind(role) {
  return `scheduled-action-${role}`;
}

function required(value, name) {
  if (value == null || value === '') throw new Error(`${name} is required`);
  return value;
}

export function buildScheduledActionRecordWrite(input) {
  const recordId = required(input?.record_id, 'record_id');
  const operation = input.operation || 'upsert-record';
  const writes = [
    write(graphAddress('record', recordId), graphPath('record'), {
      kind: graphKind('record'),
      role: 'record',
      record_id: recordId,
      fields: input.fields || {},
      owner_ref: input.owner_ref || null
    })
  ];

  for (const relation of input.relationships || []) {
    const relationId = relation.relationship_id || `${recordId}:${relation.relation_role}:${relation.target_id}`;
    writes.push(write(graphAddress('relationship', relationId), graphPath('relationship'), {
      kind: graphKind('relationship'),
      source_id: recordId,
      target_id: required(relation.target_id, 'relationship.target_id'),
      relation_role: required(relation.relation_role, 'relationship.relation_role'),
      evidence: relation.evidence || null
    }));
  }

  if (input.time_window) {
    const timeWindowId = input.time_window.time_window_id || `${recordId}:time-window`;
    writes.push(write(graphAddress('time-window', timeWindowId), graphPath('time-window'), {
      ...input.time_window,
      kind: graphKind('time-window'),
      time_window_id: timeWindowId,
      record_id: recordId
    }));
  }

  // The owner action-descriptors this record fires when due. Each row carries its OWN
  // complete dispatch config as DATA (`dispatch.name` = any slot address, `dispatch.input`
  // = its opaque payload) — row-carried dispatch doctrine: the fire definition re-reads
  // the row and asks exactly what it names, so the scheduler never learns owner
  // invocation shapes. A workflow target is `{name:'slot::workflow', input:{operation:
  // 'execute_definition', definition_id, input}}` (ask names are slot addresses, never
  // bare definition ids). Receipts stay keyed by (record_id, operation). Written at a
  // queryable kind path like every other role.
  for (const action of input.actions || []) {
    const actionId = action.action_id || `${recordId}:${action.operation || action.action_id}`;
    const dispatch = required(action.dispatch, 'action.dispatch');
    required(dispatch.name, 'action.dispatch.name');
    writes.push(write(graphAddress('action', actionId), graphPath('action'), {
      kind: graphKind('action'),
      action_id: actionId,
      record_id: recordId,
      operation: action.operation || action.action_id,
      dispatch
    }));
  }

  return {
    operation,
    record_id: recordId,
    writes,
    receipt_preview: {
      operation,
      record_id: recordId,
      write_count: writes.length,
      idempotency_key_material: [recordId, operation],
      blocked_reason_refs: [],
      source_descriptor_refs: input.source_descriptor_refs || []
    }
  };
}

export function buildScheduledActionStateWrite(input) {
  const recordId = required(input?.record_id, 'record_id');
  const operation = required(input?.operation, 'operation');
  const receiptId = input.receipt_id || `${recordId}:${operation}:${input.observed_at || 'pending'}`;
  const writes = [
    write(graphAddress('receipt', receiptId), graphPath('receipt'), {
      kind: graphKind('receipt'),
      receipt_id: receiptId,
      record_id: recordId,
      operation,
      observed_at: input.observed_at || null,
      reason_refs: input.reason_refs || []
    })
  ];

  return {
    operation,
    record_id: recordId,
    writes,
    receipt_preview: {
      operation,
      record_id: recordId,
      write_count: writes.length,
      idempotency_key_material: [recordId, operation, receiptId],
      blocked_reason_refs: input.reason_refs || [],
      source_descriptor_refs: input.source_descriptor_refs || []
    }
  };
}

export function buildReplaceTimeWindowWrite(input) {
  const recordId = required(input?.record_id, 'record_id');
  return buildScheduledActionRecordWrite({
    operation: 'replace-time-window',
    record_id: recordId,
    fields: input.fields || {},
    time_window: {
      ...(input.time_window || {}),
      time_window_id: required(input.time_window?.time_window_id, 'time_window.time_window_id')
    },
    relationships: input.relationships || [],
    source_descriptor_refs: input.source_descriptor_refs || []
  });
}
