// ../bitfield-packages/packages/timed-action/do-work/process-scripts/evaluate-due-scheduled-actions-cli.ts
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ../bitfield-packages/packages/timed-action/do-work/evaluate-due-scheduled-actions.ts
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function actionOperation(action) {
  return action?.operation ?? action?.action_id ?? null;
}
function receiptKey(record_id, operation) {
  return JSON.stringify([record_id ?? null, operation ?? null]);
}
function resolveDueAt(window) {
  return window?.due_at ?? window?.start ?? null;
}
function evaluateDueScheduledActions(input = {}) {
  const timeWindows = arr(input.time_windows);
  const actions = arr(input.actions);
  const receipts = arr(input.receipts);
  const nowMs = input.now != null ? Date.parse(input.now) : Date.now();
  if (Number.isNaN(nowMs)) throw new Error("evaluate-due-scheduled-actions: `now` is not a parseable timestamp");
  const windowByRecord = new Map(timeWindows.filter((w) => w?.record_id != null).map((w) => [w.record_id, w]));
  const firedKeys = new Set(receipts.filter((r) => r?.record_id != null).map((r) => receiptKey(r.record_id, r.operation)));
  const due = [];
  for (const action of actions) {
    const recordId = action?.record_id;
    if (recordId == null) continue;
    const window = windowByRecord.get(recordId) || null;
    const dueAt = resolveDueAt(window);
    if (dueAt == null) continue;
    const dueMs = Date.parse(dueAt);
    if (Number.isNaN(dueMs) || nowMs < dueMs) continue;
    const operation = actionOperation(action);
    if (firedKeys.has(receiptKey(recordId, operation))) continue;
    if (action.dispatch == null || action.dispatch.name == null) continue;
    due.push({
      record_id: recordId,
      operation,
      action_id: action.action_id ?? null,
      time_window_id: window?.time_window_id ?? null,
      due_at: dueAt,
      evaluated_at: new Date(nowMs).toISOString()
    });
  }
  return {
    evaluated_at: new Date(nowMs).toISOString(),
    scanned_action_count: actions.length,
    already_fired_count: firedKeys.size,
    due_count: due.length,
    due
  };
}

// ../bitfield-packages/packages/timed-action/do-work/process-scripts/evaluate-due-scheduled-actions-cli.ts
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[i + 1] ?? "";
  }
  return flags;
}
function projectPath(value, path) {
  if (!path) return value;
  let cur = value;
  for (const seg of path.split(".")) {
    if (cur == null) return null;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}
function payloadsFromFindItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    if (it == null || typeof it !== "object") return null;
    const rec = it;
    if (rec.payload !== void 0) return rec.payload;
    if (typeof rec.payload_json_text === "string") {
      try {
        return JSON.parse(rec.payload_json_text);
      } catch {
        return null;
      }
    }
    return null;
  }).filter((p) => p != null);
}
function normalizeInput(input) {
  const rawItems = (key) => {
    const v = input[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray(v.items)) return v.items;
    return null;
  };
  const rolePairs = [
    ["records", "records_items"],
    ["time_windows", "time_windows_items"],
    ["actions", "actions_items"],
    ["receipts", "receipts_items"]
  ];
  const out = { now: input.now };
  for (const [clean, rawKey] of rolePairs) {
    if (Array.isArray(input[clean])) out[clean] = input[clean];
    else {
      const items = rawItems(rawKey);
      out[clean] = items ? payloadsFromFindItems(items) : [];
    }
  }
  return out;
}
var ROLE_FLAGS = [
  ["records-items-json", "records_items"],
  ["time-windows-items-json", "time_windows_items"],
  ["actions-items-json", "actions_items"],
  ["receipts-items-json", "receipts_items"]
];
function main(argv) {
  const flags = parseArgs(argv);
  let parsed;
  if (ROLE_FLAGS.some(([f]) => flags[f] != null)) {
    parsed = {};
    for (const [flag, key] of ROLE_FLAGS) parsed[key] = flags[flag] ? JSON.parse(flags[flag]) : [];
  } else {
    const raw = flags["input-json"] != null ? flags["input-json"] : flags["input-file"] ? readFileSync(flags["input-file"], "utf8") : "";
    if (!raw) {
      process.stderr.write("usage: evaluate-due-scheduled-actions-cli (--records-items-json ... --time-windows-items-json ... --actions-items-json ... --receipts-items-json ... | --input-json <json> | --input-file <path>) [--now <iso>] [--output-json <path>] [--result-path <dotted>]\n");
      process.exit(2);
      return;
    }
    parsed = JSON.parse(raw);
  }
  if (flags["now"]) parsed.now = flags["now"];
  const input = normalizeInput(parsed);
  const result = evaluateDueScheduledActions(input);
  const projected = projectPath(result, flags["result-path"] ?? "");
  const out = JSON.stringify(projected);
  if (flags["output-json"]) writeFileSync(flags["output-json"], out, "utf8");
  else process.stdout.write(out + "\n");
}
var invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`evaluate-due-scheduled-actions-cli: ${err.message}
`);
    process.exit(1);
  }
}
export {
  main
};
