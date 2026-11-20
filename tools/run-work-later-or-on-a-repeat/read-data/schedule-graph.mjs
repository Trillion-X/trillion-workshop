// read-data/schedule-graph.mjs
//
// Ported from the old Bitfield package timed-action read-data/read-scheduled-action-graph.ts (commit d926b7adb8, read
// lines 1-52 in full). The one read the schedule screens and the UI use: each record with its time window, relationships,
// actions, owner evidence, latest receipt, due state and group, plus a proof of what was read. Pure: every input is passed in;
// `options.now` is the clock (no Date.now() when it is given).
//
// Non-Negotiable Invariants
//   1. A record's due state is "due" when its window start has passed, "scheduled" when it has not, "unscheduled" with no
//      window; a latest receipt of canceled or completed wins over the time.
//   2. Groups come from the active view's group field; a record with no value is grouped under "Other", never dropped.
//   3. The proof counts every row read, so a short read is visible.

const arrayFrom = value => (Array.isArray(value) ? value : []);

function byKey(rows, key) {
  return new Map(arrayFrom(rows).filter(row => row && row[key] != null).map(row => [row[key], row]));
}

function rowsByKey(rows, key) {
  const map = new Map();
  for (const row of arrayFrom(rows)) {
    if (!row || row[key] == null) continue;
    const bucket = map.get(row[key]) || [];
    bucket.push(row);
    map.set(row[key], bucket);
  }
  return map;
}

function latestByRecord(rows) {
  const map = new Map();
  for (const row of arrayFrom(rows)) {
    if (!row?.record_id) continue;
    const current = map.get(row.record_id);
    if (!current || String(row.observed_at || '') >= String(current.observed_at || '')) map.set(row.record_id, row);
  }
  return map;
}

function dueState(start, now) {
  if (!start) return 'unscheduled';
  return Date.parse(start) <= Date.parse(now) ? 'due' : 'scheduled';
}

function viewLabel(record) {
  const fields = record?.fields || {};
  return String(fields.label || fields.title || '');
}

export function readScheduledActionGraph(input = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const records = arrayFrom(input.records);
  const relationships = arrayFrom(input.relationships);
  const timeWindows = arrayFrom(input.time_windows);
  const actions = arrayFrom(input.actions);
  const ownerEvidence = arrayFrom(input.owner_evidence);
  const receipts = arrayFrom(input.receipts);
  const views = arrayFrom(input.views);

  const timeByRecord = byKey(timeWindows, 'record_id');
  const actionByRecord = rowsByKey(actions, 'record_id');
  const relationByRecord = rowsByKey(relationships, 'source_id');
  const evidenceByRecord = rowsByKey(ownerEvidence, 'record_id');
  const latestReceipt = latestByRecord(receipts);
  const activeView = views[0] || { view_id: 'default', group_by_field: 'group', sort_by: 'start' };

  const items = records.map(record => {
    const timeWindow = timeByRecord.get(record.record_id) || null;
    const evidence = evidenceByRecord.get(record.record_id) || [];
    const blocked = evidence.filter(row => row.allowed === false);
    const due = dueState(timeWindow?.start, now);
    const receipt = latestReceipt.get(record.record_id) || null;
    const group = String(record.fields?.[activeView.group_by_field] || 'Other');
    return {
      record_id: record.record_id,
      label: viewLabel(record),
      group,
      fields: record.fields || {},
      relationships: relationByRecord.get(record.record_id) || [],
      time_window: timeWindow,
      due_state: receipt?.operation === 'canceled' ? 'canceled' : receipt?.operation === 'completed' ? 'completed' : due,
      actions: actionByRecord.get(record.record_id) || [],
      owner_evidence: evidence,
      blocked_action_count: blocked.length,
      receipt,
      next_action_refs: evidence.flatMap(row => arrayFrom(row.next_action_refs)),
    };
  }).sort((left, right) => {
    const leftStart = left.time_window?.start || '';
    const rightStart = right.time_window?.start || '';
    return leftStart.localeCompare(rightStart) || left.record_id.localeCompare(right.record_id);
  });

  const groups = {};
  for (const item of items) {
    groups[item.group] ||= [];
    groups[item.group].push(item.record_id);
  }

  return {
    projection_id: activeView.view_id || 'default',
    items,
    groups,
    proof: {
      record_count: records.length,
      relationship_count: relationships.length,
      time_window_count: timeWindows.length,
      action_descriptor_count: actions.length,
      owner_evidence_count: ownerEvidence.length,
      blocked_action_count: items.reduce((sum, item) => sum + item.blocked_action_count, 0),
      receipt_count: receipts.length,
      source_addresses: arrayFrom(input.source_addresses),
    },
  };
}
