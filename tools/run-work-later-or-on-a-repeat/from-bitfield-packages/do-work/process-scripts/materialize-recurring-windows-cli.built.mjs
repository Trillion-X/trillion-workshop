// ../bitfield-packages/packages/timed-action/do-work/process-scripts/materialize-recurring-windows-cli.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ../bitfield-packages/packages/timed-action/do-work/materialize-recurring-windows.ts
var DAY_MS = 864e5;
var MAX_CALENDAR_SCAN_DAYS = 4096;
var MAX_GAP_SEARCH_MINUTES = 2160;
function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function identityText(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function pad(value) {
  return value < 10 ? `0${value}` : String(value);
}
function parseDate(date) {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(year) || utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return { year, month, day };
}
function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}
function formatUtcDate(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function addCivilDays(date, days) {
  const parsed = parseDate(date);
  return formatUtcDate(Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * DAY_MS);
}
function addCivilMinutes(start, minutes) {
  const date = parseDate(start.date);
  const time = parseTime(start.time);
  const value = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute) + minutes * 6e4;
  const output = new Date(value);
  return {
    date: formatUtcDate(value),
    time: `${pad(output.getUTCHours())}:${pad(output.getUTCMinutes())}`
  };
}
function weekday(date) {
  const parsed = parseDate(date);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}
function localParts(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(instantMs));
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
function timezoneOffsetMinutesAt(instantMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(instantMs));
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return Math.round((asUtc - instantMs) / 6e4);
}
function civilEpochMs(civil) {
  const date = parseDate(civil.date);
  const time = parseTime(civil.time);
  return Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
}
function possibleInstants(civil, timezone) {
  const guess = civilEpochMs(civil);
  const offsets = /* @__PURE__ */ new Set();
  for (let hour = -36; hour <= 36; hour += 1) offsets.add(timezoneOffsetMinutesAt(guess + hour * 36e5, timezone));
  const candidates = [...offsets].map((offset) => guess - offset * 6e4).filter((instant) => {
    const parts = localParts(instant, timezone);
    return parts.date === civil.date && parts.time === civil.time;
  });
  return [...new Set(candidates)].sort((left, right) => left - right);
}
function resolveStart(requested, timezone, gap, fold) {
  let candidates = possibleInstants(requested, timezone);
  let resolved = requested;
  if (candidates.length === 0 && gap === "next-valid") {
    for (let minute = 1; minute <= MAX_GAP_SEARCH_MINUTES; minute += 1) {
      const probe = addCivilMinutes(requested, minute);
      candidates = possibleInstants(probe, timezone);
      if (candidates.length > 0) {
        resolved = probe;
        break;
      }
    }
  }
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [{ requested, resolved, instant_ms: candidates[0], fold: "unique" }];
  if (fold === "both") {
    return [
      { requested, resolved, instant_ms: candidates[0], fold: "earlier" },
      { requested, resolved, instant_ms: candidates[candidates.length - 1], fold: "later" }
    ];
  }
  const instant = fold === "later" ? candidates[candidates.length - 1] : candidates[0];
  return [{ requested, resolved, instant_ms: instant, fold }];
}
function scheduleError(schedule) {
  if (!text(schedule?.schedule_id) || !identityText(schedule?.source_generation) || !identityText(schedule?.schedule_revision)) return "missing_identity_component";
  if (!parseDate(schedule?.start_local_date) || !parseTime(schedule?.local_window?.start)) return "invalid_local_window";
  if (!Number.isInteger(schedule?.local_window?.duration_minutes) || schedule.local_window.duration_minutes <= 0 || schedule.local_window.duration_minutes > 10080) return "invalid_duration";
  const interval = schedule?.cadence?.interval ?? 1;
  if (!Number.isInteger(interval) || interval <= 0 || interval > 512) return "invalid_interval";
  if (schedule?.cadence?.unit !== "day" && schedule?.cadence?.unit !== "week") return "invalid_cadence_unit";
  if (schedule.cadence.unit === "week" && (!Array.isArray(schedule.cadence.weekdays) || schedule.cadence.weekdays.length === 0 || schedule.cadence.weekdays.some((value) => !Number.isInteger(value) || value < 0 || value > 6))) return "invalid_weekdays";
  if (schedule.dst?.gap && schedule.dst.gap !== "skip" && schedule.dst.gap !== "next-valid") return "invalid_gap_policy";
  if (schedule.dst?.fold && schedule.dst.fold !== "earlier" && schedule.dst.fold !== "later" && schedule.dst.fold !== "both") return "invalid_fold_policy";
  if (!text(schedule?.action?.operation) || !text(schedule?.action?.owner_ref) || !text(schedule?.action?.owner_dispatch?.name)) return "invalid_action_owner";
  if (schedule?.action?.completion?.mode !== "synchronous-owner-return") return "unsupported_completion_mode";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format();
  } catch {
    return "invalid_timezone";
  }
  return null;
}
function isCandidateDate(schedule, date, offsetDays) {
  const interval = schedule.cadence.interval ?? 1;
  if (schedule.cadence.unit === "day") return offsetDays % interval === 0;
  const start = parseDate(schedule.start_local_date);
  const startWeekStart = Date.UTC(start.year, start.month - 1, start.day) - weekday(schedule.start_local_date) * DAY_MS;
  const candidate = parseDate(date);
  const candidateWeekStart = Date.UTC(candidate.year, candidate.month - 1, candidate.day) - weekday(date) * DAY_MS;
  const weekIndex = Math.round((candidateWeekStart - startWeekStart) / (7 * DAY_MS));
  return weekIndex >= 0 && weekIndex % interval === 0 && schedule.cadence.weekdays.includes(weekday(date));
}
function recurringOccurrenceKey(identity) {
  return `timed-action.recurring-window::${encodeURIComponent(JSON.stringify([
    identity.schedule_id,
    String(identity.source_generation),
    String(identity.schedule_revision),
    identity.timezone,
    identity.requested_start.date,
    identity.requested_start.time,
    identity.requested_end.date,
    identity.requested_end.time,
    identity.resolved_start.date,
    identity.resolved_start.time,
    identity.resolved_end.date,
    identity.resolved_end.time,
    identity.fold
  ]))}`;
}
function ownerOutcomeProven(state) {
  const outcome = state.owner_outcome;
  return outcome?.proven === true && !!text(outcome.owner_ref) && !!text(outcome.proof_ref) && !!text(outcome.observed_at);
}
function materializationCommitted(state) {
  return state.materialization_key === state.occurrence_key && !!text(state.materialized_at);
}
function materializeRecurringWindows(input = {}) {
  const schedules = Array.isArray(input.schedules) ? [...input.schedules] : [];
  const states = Array.isArray(input.occurrence_states) ? input.occurrence_states : [];
  const maxDays = Number.isInteger(input.max_calendar_scan_days) && input.max_calendar_scan_days > 0 ? Math.min(input.max_calendar_scan_days, MAX_CALENDAR_SCAN_DAYS) : MAX_CALENDAR_SCAN_DAYS;
  const scheduleIdCounts = /* @__PURE__ */ new Map();
  for (const schedule of schedules) if (text(schedule?.schedule_id)) scheduleIdCounts.set(schedule.schedule_id, (scheduleIdCounts.get(schedule.schedule_id) ?? 0) + 1);
  const stateByKey = /* @__PURE__ */ new Map();
  for (const state of states) {
    if (!text(state?.occurrence_key)) continue;
    const bucket = stateByKey.get(state.occurrence_key) ?? [];
    bucket.push(state);
    stateByKey.set(state.occurrence_key, bucket);
  }
  const materializations = [];
  const active_occurrences = [];
  const rejected_schedules = [];
  const skipped_resolutions = [];
  for (const schedule of schedules.sort((left, right) => String(left?.schedule_id ?? "").localeCompare(String(right?.schedule_id ?? "")))) {
    const error = scheduleError(schedule);
    if (error || (scheduleIdCounts.get(schedule.schedule_id) ?? 0) !== 1) {
      rejected_schedules.push({ schedule_id: String(schedule?.schedule_id ?? ""), reason: error ?? "conflicting_schedule_id" });
      continue;
    }
    const gap = schedule.dst?.gap ?? "skip";
    const fold = schedule.dst?.fold ?? "earlier";
    const requestedTime = schedule.local_window.start;
    let selected = false;
    for (let offsetDays = 0; offsetDays < maxDays && !selected; offsetDays += 1) {
      const date = addCivilDays(schedule.start_local_date, offsetDays);
      if (!isCandidateDate(schedule, date, offsetDays)) continue;
      const requestedStart = { date, time: requestedTime };
      const requestedEnd = addCivilMinutes(requestedStart, schedule.local_window.duration_minutes);
      const starts = resolveStart(requestedStart, schedule.timezone, gap, fold);
      if (starts.length === 0) {
        skipped_resolutions.push({ schedule_id: schedule.schedule_id, requested_start: requestedStart, timezone: schedule.timezone, reason: "dst_gap_skip" });
        continue;
      }
      const candidates = starts.map((start) => {
        const resolvedEnd = addCivilMinutes(start.resolved, schedule.local_window.duration_minutes);
        const key = recurringOccurrenceKey({
          schedule_id: schedule.schedule_id,
          source_generation: schedule.source_generation,
          schedule_revision: schedule.schedule_revision,
          timezone: schedule.timezone,
          requested_start: requestedStart,
          requested_end: requestedEnd,
          resolved_start: start.resolved,
          resolved_end: resolvedEnd,
          fold: start.fold
        });
        return { start, resolvedEnd, key };
      });
      if (candidates.every((candidate) => (stateByKey.get(candidate.key) ?? []).some(ownerOutcomeProven))) continue;
      for (const candidate of candidates) {
        const statesForOccurrence = stateByKey.get(candidate.key) ?? [];
        if (statesForOccurrence.some(ownerOutcomeProven)) continue;
        const committed = statesForOccurrence.some(materializationCommitted);
        const occurrence = {
          occurrence_key: candidate.key,
          schedule_id: schedule.schedule_id,
          schedule_label: text(schedule.label) ?? text(schedule.title) ?? text(schedule.name),
          source_generation: String(schedule.source_generation),
          schedule_revision: String(schedule.schedule_revision),
          timezone: schedule.timezone,
          requested_local_window: { start: requestedStart, end: requestedEnd },
          resolved_local_window: { start: candidate.start.resolved, end: candidate.resolvedEnd, fold: candidate.start.fold },
          start: new Date(candidate.start.instant_ms).toISOString(),
          end: new Date(candidate.start.instant_ms + schedule.local_window.duration_minutes * 6e4).toISOString(),
          action: schedule.action
        };
        if (!committed) {
          materializations.push({
            kind: "recurring-window-materialization",
            materialization_key: candidate.key,
            compare_exchange_key: candidate.key,
            occurrence,
            initial_state: { occurrence_key: candidate.key, materialization_key: candidate.key, materialized_at: null }
          });
        }
        active_occurrences.push({ ...occurrence, retry_same_occurrence: committed });
      }
      selected = true;
    }
    if (!selected) rejected_schedules.push({ schedule_id: schedule.schedule_id, reason: "scan_limit_without_unresolved_occurrence" });
  }
  return {
    schema: "timed-action.recurring-window-materialization.v1",
    materializations,
    active_occurrences,
    rejected_schedules,
    skipped_resolutions
  };
}

// ../bitfield-packages/packages/timed-action/do-work/process-scripts/materialize-recurring-windows-cli.ts
function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) flags[argv[index].slice(2)] = argv[index + 1] ?? "";
  }
  return flags;
}
function payloads(items) {
  const rows = Array.isArray(items) ? items : items && typeof items === "object" && Array.isArray(items.items) ? items.items : [];
  return rows.map((row) => {
    if (!row || typeof row !== "object") return null;
    const item = row;
    if (item.payload !== void 0) return item.payload;
    if (typeof item.payload_json_text === "string") {
      try {
        return JSON.parse(item.payload_json_text);
      } catch {
        return null;
      }
    }
    return null;
  }).filter((value) => value != null);
}
function iso(value) {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error("observed-at must be a parseable ISO timestamp");
  }
  return new Date(value).toISOString();
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function labelText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function occurrenceBindingValue(occurrence, path) {
  if (typeof path !== "string" || !["occurrence_key", "schedule_id", "start", "end"].includes(path)) {
    throw new Error(`unsupported timed-action occurrence binding: ${String(path)}`);
  }
  return occurrence[path];
}
function bindOccurrenceValues(value, occurrence, depth = 0) {
  if (depth > 32) throw new Error("owner dispatch input exceeds occurrence-binding depth");
  if (Array.isArray(value)) return value.map((item) => bindOccurrenceValues(item, occurrence, depth + 1));
  if (!value || typeof value !== "object") return value;
  const row = value;
  if (row.$kind === "timed-action.occurrence-binding") return occurrenceBindingValue(occurrence, row.path);
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, bindOccurrenceValues(item, occurrence, depth + 1)]));
}
function materializationsForStorage(input) {
  const observedAt = iso(input.observed_at);
  const reduced = materializeRecurringWindows({
    schedules: payloads(input.schedules_items),
    occurrence_states: payloads(input.states_items)
  });
  const materializations = reduced.materializations.map((row) => {
    const occurrence = row.occurrence;
    const action = occurrence.action;
    const occurrenceKey = String(occurrence.occurrence_key);
    const scheduleLabel = labelText(occurrence.schedule_label);
    const suffix = digest(occurrenceKey);
    const recordId = `timed-action.recurring-occurrence:${suffix}`;
    const stateAddress = `timed-action.recurring-occurrence-state::${suffix}`;
    const receiptAddress = `timed-action.scheduled-action.receipt::${suffix}:${digest(action.operation)}`;
    const state = {
      kind: "recurring-window-occurrence-state",
      occurrence_key: occurrenceKey,
      materialization_key: occurrenceKey,
      materialized_at: observedAt,
      schedule_id: occurrence.schedule_id,
      owner_outcome: null
    };
    const wrapperInput = {
      owner_dispatch: {
        name: action.owner_dispatch.name,
        input: bindOccurrenceValues(action.owner_dispatch.input, occurrence)
      },
      owner_ref: action.owner_ref,
      occurrence_state: { address: stateAddress, ...state },
      scheduled_receipt: { address: receiptAddress, record_id: recordId, operation: action.operation }
    };
    const writes = [
      {
        address: `timed-action.scheduled-action.record::${suffix}`,
        path: ["current-item", "scheduled-action-record"],
        payload: {
          kind: "scheduled-action-record",
          role: "record",
          record_id: recordId,
          owner_ref: action.owner_ref,
          recurrence_key: occurrenceKey,
          ...scheduleLabel ? { fields: { label: scheduleLabel } } : {}
        }
      },
      {
        address: `timed-action.scheduled-action.time-window::${suffix}`,
        path: ["current-item", "scheduled-action-time-window"],
        payload: { kind: "scheduled-action-time-window", time_window_id: `window:${suffix}`, record_id: recordId, start: occurrence.start, end: occurrence.end, timezone: occurrence.timezone }
      },
      {
        address: `timed-action.scheduled-action.action::${suffix}`,
        path: ["current-item", "scheduled-action-action"],
        payload: {
          kind: "scheduled-action-action",
          action_id: `action:timed-action.recurring-owner:${suffix}`,
          record_id: recordId,
          operation: action.operation,
          completion: action.completion,
          recurrence_key: occurrenceKey,
          dispatch: {
            name: "slot::workflow",
            input: {
              operation: "execute_definition",
              definition_id: "action:timed-action.run-recurring-owner-v1",
              include_output: true,
              include_steps: false,
              input: wrapperInput
            }
          }
        }
      },
      { address: stateAddress, path: ["current-item", "recurring-window-occurrence-state"], payload: state }
    ];
    return { operation: "materialize-recurring-occurrence", record_id: recordId, writes, occurrence_key: occurrenceKey };
  });
  return { ...reduced, observed_at: observedAt, materializations };
}
function main(argv) {
  const flags = parseArgs(argv);
  const parsed = flags["input-file"] ? JSON.parse(readFileSync(flags["input-file"], "utf8")) : {
    schedules_items: flags["schedules-items-json"] ? JSON.parse(flags["schedules-items-json"]) : [],
    states_items: flags["states-items-json"] ? JSON.parse(flags["states-items-json"]) : [],
    observed_at: flags["observed-at"]
  };
  const result = materializationsForStorage(parsed);
  const output = `${JSON.stringify(result)}
`;
  if (flags["output-json"]) writeFileSync(flags["output-json"], output, "utf8");
  else process.stdout.write(output);
}
var invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && invoked === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`materialize-recurring-windows-cli: ${error.message}
`);
    process.exit(1);
  }
}
export {
  main,
  materializationsForStorage
};
