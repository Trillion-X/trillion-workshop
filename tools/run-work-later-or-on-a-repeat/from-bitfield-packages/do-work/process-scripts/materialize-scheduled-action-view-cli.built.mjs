// ../bitfield-packages/packages/timed-action/do-work/process-scripts/materialize-scheduled-action-view-cli.ts
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ../bitfield-packages/packages/timed-action/read-data/read-scheduled-action-graph.ts
var EMPTY_GRAPH = Object.freeze({
  records: [],
  relationships: [],
  time_windows: [],
  actions: [],
  owner_evidence: [],
  receipts: [],
  views: []
});
function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}
function byKey(rows, key) {
  return new Map(arrayFrom(rows).filter((row) => row && row[key] != null).map((row) => [row[key], row]));
}
function rowsByKey(rows, key) {
  const map = /* @__PURE__ */ new Map();
  for (const row of arrayFrom(rows)) {
    if (!row || row[key] == null) continue;
    const bucket = map.get(row[key]) || [];
    bucket.push(row);
    map.set(row[key], bucket);
  }
  return map;
}
function latestByRecord(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const row of arrayFrom(rows)) {
    if (!row?.record_id) continue;
    const current = map.get(row.record_id);
    if (!current || String(row.observed_at || "") >= String(current.observed_at || "")) {
      map.set(row.record_id, row);
    }
  }
  return map;
}
function dueState(start, now) {
  if (!start) return "unscheduled";
  return Date.parse(start) <= Date.parse(now) ? "due" : "scheduled";
}
function viewLabel(record) {
  const fields = record?.fields || {};
  return String(fields.label || fields.title || "");
}
function readScheduledActionGraph(input = EMPTY_GRAPH, options = {}) {
  const now = options.now || (/* @__PURE__ */ new Date()).toISOString();
  const records = arrayFrom(input.records);
  const relationships = arrayFrom(input.relationships);
  const timeWindows = arrayFrom(input.time_windows);
  const actions = arrayFrom(input.actions);
  const ownerEvidence = arrayFrom(input.owner_evidence);
  const receipts = arrayFrom(input.receipts);
  const views = arrayFrom(input.views);
  const timeByRecord = byKey(timeWindows, "record_id");
  const actionByRecord = rowsByKey(actions, "record_id");
  const relationByRecord = rowsByKey(relationships, "source_id");
  const evidenceByRecord = rowsByKey(ownerEvidence, "record_id");
  const latestReceipt = latestByRecord(receipts);
  const activeView = views[0] || { view_id: "default", group_by_field: "group", sort_by: "start" };
  const items = records.map((record) => {
    const timeWindow = timeByRecord.get(record.record_id) || null;
    const evidence = evidenceByRecord.get(record.record_id) || [];
    const blocked = evidence.filter((row) => row.allowed === false);
    const due = dueState(timeWindow?.start, now);
    const receipt = latestReceipt.get(record.record_id) || null;
    const group = String(record.fields?.[activeView.group_by_field] || "Other");
    return {
      record_id: record.record_id,
      label: viewLabel(record),
      group,
      fields: record.fields || {},
      relationships: relationByRecord.get(record.record_id) || [],
      time_window: timeWindow,
      due_state: receipt?.operation === "canceled" ? "canceled" : receipt?.operation === "completed" ? "completed" : due,
      actions: actionByRecord.get(record.record_id) || [],
      owner_evidence: evidence,
      blocked_action_count: blocked.length,
      receipt,
      next_action_refs: evidence.flatMap((row) => arrayFrom(row.next_action_refs))
    };
  }).sort((left, right) => {
    const leftStart = left.time_window?.start || "";
    const rightStart = right.time_window?.start || "";
    return leftStart.localeCompare(rightStart) || left.record_id.localeCompare(right.record_id);
  });
  const groups = {};
  for (const item of items) {
    groups[item.group] ||= [];
    groups[item.group].push(item.record_id);
  }
  return {
    projection_id: activeView.view_id || "default",
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
      source_addresses: arrayFrom(input.source_addresses)
    }
  };
}

// ../bitfield-packages/packages/timed-action/do-work/process-scripts/materialize-scheduled-action-view-cli.ts
function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) flags[value.slice(2)] = argv[index + 1] ?? "";
  }
  return flags;
}
function payloadsFromFindItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (!item || typeof item !== "object") return null;
    const row = item;
    if (row.payload !== void 0) return row.payload;
    if (typeof row.payload_json_text === "string") {
      try {
        return JSON.parse(row.payload_json_text);
      } catch {
        return null;
      }
    }
    return null;
  }).filter((value) => value != null);
}
function normalizeInput(input) {
  const out = {
    records: payloadsFromFindItems(input.records_items),
    relationships: payloadsFromFindItems(input.relationships_items),
    time_windows: payloadsFromFindItems(input.time_windows_items),
    actions: payloadsFromFindItems(input.actions_items),
    owner_evidence: payloadsFromFindItems(input.owner_evidence_items),
    receipts: payloadsFromFindItems(input.receipts_items),
    views: payloadsFromFindItems(input.views_items)
  };
  if (Array.isArray(input.source_addresses)) out.source_addresses = input.source_addresses;
  return out;
}
function buildInput(flags) {
  if (flags["input-file"]) {
    return JSON.parse(readFileSync(flags["input-file"], "utf8"));
  }
  return {
    records_items: flags["records-items-json"] ? JSON.parse(flags["records-items-json"]) : [],
    relationships_items: flags["relationships-items-json"] ? JSON.parse(flags["relationships-items-json"]) : [],
    time_windows_items: flags["time-windows-items-json"] ? JSON.parse(flags["time-windows-items-json"]) : [],
    actions_items: flags["actions-items-json"] ? JSON.parse(flags["actions-items-json"]) : [],
    owner_evidence_items: flags["owner-evidence-items-json"] ? JSON.parse(flags["owner-evidence-items-json"]) : [],
    receipts_items: flags["receipts-items-json"] ? JSON.parse(flags["receipts-items-json"]) : [],
    views_items: flags["views-items-json"] ? JSON.parse(flags["views-items-json"]) : [],
    source_addresses: [
      "scheduled-action-record",
      "scheduled-action-relationship",
      "scheduled-action-time-window",
      "scheduled-action-action",
      "scheduled-action-owner-evidence",
      "scheduled-action-receipt",
      "scheduled-action-view"
    ]
  };
}
function main(argv) {
  const flags = parseArgs(argv);
  const input = normalizeInput(buildInput(flags));
  const now = flags["now"] || (/* @__PURE__ */ new Date()).toISOString();
  const view = readScheduledActionGraph(input, { now });
  const projection = {
    kind: "scheduled-action.projection",
    ...view
  };
  const output = `${JSON.stringify(projection)}
`;
  if (flags["output-json"]) writeFileSync(flags["output-json"], output, "utf8");
  else process.stdout.write(output);
}
var invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && invoked === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`materialize-scheduled-action-view-cli: ${error.message}
`);
    process.exit(1);
  }
}
export {
  main
};
