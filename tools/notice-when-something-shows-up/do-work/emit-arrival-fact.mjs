#!/usr/bin/env node
/**
 * packages/notice-when-something-shows-up/do-work/emit-arrival-fact.mjs
 *
 * Purpose
 *   The resident thing that waits. It reads the standing orders (waiter
 *   descriptor rows), starts the mechanism each one declares, and appends ONE
 *   self describing fact every time a mechanism reports that something outside
 *   became reachable or stopped being reachable.
 *
 * Non-negotiable invariants
 *   - IT APPENDS AND IT NEVER DISPATCHES. There is no workflow target, no
 *     action id, and no consumer name anywhere in this file or in the DATA it
 *     reads. Eligibility is trigger rules, which are somebody else's DATA. If a
 *     future edit makes this file call a consumer, the whole design collapses:
 *     every reactor would then have to be wired in one at a time forever.
 *   - It contains ZERO source names and ZERO branches on what kind of thing
 *     showed up. A mechanism is resolved through the capability reference its
 *     row declares. Adding a mechanism is adding a leaf file and a row, and it
 *     edits nothing here.
 *   - Sequence is resumed from the log, never from a file on disk. There is no
 *     lock. A lock whose meaning dies with its process cannot be the
 *     concurrency story for a durable log, so per waiter monotonic sequence is
 *     the story instead.
 *   - A mechanism that cannot start is recorded as a fact, never swallowed.
 *   - matched_source_refs is computed from identity, NEVER from a visible name.
 *     Two things can share a name. They cannot share an identity.
 *
 * Key concepts
 *   The arrival fact         six fields, fixed, see ARRIVAL_FIELDS below.
 *   A waiter descriptor row  names a mechanism, its settings, the record to
 *                            emit, and which fields of the scope that record
 *                            carries.
 *   The payload projection   is why the clock survives this widening unchanged:
 *                            its row projects the clock fields at the clock
 *                            address, and a volume row projects the arrival
 *                            fields, with no branch in this file.
 *
 * Security
 *   Holds no credential. Talks to exactly one address, the carrier the runtime
 *   handed it. Loads mechanism modules only by a plain leaf filename that must
 *   also answer to the capability reference the row declared, so DATA cannot
 *   point a capability name at a different leaf and cannot escape the folder.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The six fields of the arrival fact. Fixed by the plan, field for field.
 *  A mechanism may not contribute a field with any of these names. */
export const ARRIVAL_FIELDS = Object.freeze([
  "waiter_ref",
  "condition",
  "observed_at",
  "observed_identity",
  "matched_source_refs",
  "sequence",
]);

/** The two polarities. Closed by the physics of the fact rather than by
 *  preference: a thing either became reachable or stopped being reachable. */
export const CONDITIONS = Object.freeze({
  reachable: "became-reachable",
  unreachable: "became-unreachable",
});

const MECHANISM_LEAF_NAME = /^[a-z][a-z0-9-]*\.mjs$/;

export class WaiterRowRefused extends Error {
  constructor(message, { waiterRef, reason } = {}) {
    super(message);
    this.name = "WaiterRowRefused";
    this.waiterRef = waiterRef ?? null;
    this.reason = reason ?? "refused";
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Resolve this process's carrier from owner projected runtime DATA.
 *
 *  A local app is selected by stable app identity. The shared connector discovers
 *  its current authority privately for every request. A URL is
 *  accepted only when a caller hands one over explicitly, which is what a hosted
 *  deployment with a declared name does. Nothing here derives an address from a
 *  port: since 2026-09-09 no local app has one. */
export function resolveRunningShellConfig(env, options = {}) {
  const partition = nonEmpty(env.BITFIELD_ARRIVAL_PARTITION) || nonEmpty(env.BITFIELD_PARTITION);
  if (!partition) return null;
  const appId = nonEmpty(env.RUNNING_APP_APP_ID);
  if (appId) return { appId, partition };
  const url = nonEmpty(env.BITFIELD_TARGET_CARRIER_URL) || currentAddressFromFile(env, options);
  return url ? { url, partition } : null;
}

export function currentAddressFromFile(env, options = {}) {
  const addressFile = nonEmpty(env.BITFIELD_TARGET_CARRIER_URL_FILE);
  if (!addressFile) return null;
  const readFile = options.readFileSync;
  if (typeof readFile !== "function") return null;
  try {
    return nonEmpty(readFile(addressFile, "utf8"));
  } catch {
    return null;
  }
}

/** Validate one waiter descriptor row.
 *
 *  Pure, so a hostile or malformed row is refused by a tested function rather
 *  than by whatever happens to throw first inside the resident loop. */
export function readWaiterRow(row) {
  if (!row || typeof row !== "object") {
    throw new WaiterRowRefused("A waiter descriptor row must be an object", { reason: "not-an-object" });
  }
  const waiterRef = nonEmpty(row.id);
  if (!waiterRef) {
    throw new WaiterRowRefused("A waiter descriptor row must carry an id", { reason: "missing-id" });
  }
  const mechanismRef = nonEmpty(row.mechanism_capability_ref);
  if (!mechanismRef) {
    throw new WaiterRowRefused(
      `Waiter ${waiterRef} names no mechanism capability`,
      { waiterRef, reason: "missing-mechanism-capability-ref" },
    );
  }
  const leaf = nonEmpty(row.mechanism_leaf);
  if (!leaf || !MECHANISM_LEAF_NAME.test(leaf)) {
    throw new WaiterRowRefused(
      `Waiter ${waiterRef} names no usable mechanism leaf`,
      { waiterRef, reason: "unusable-mechanism-leaf" },
    );
  }
  const emitted = row.emitted_record;
  if (!emitted || typeof emitted !== "object") {
    throw new WaiterRowRefused(
      `Waiter ${waiterRef} declares no emitted record`,
      { waiterRef, reason: "missing-emitted-record" },
    );
  }
  const changeKind = nonEmpty(emitted.change_kind);
  const addressLabel = nonEmpty(emitted.address_label);
  const pathLabels = Array.isArray(emitted.path_labels)
    ? emitted.path_labels.filter((label) => nonEmpty(label))
    : [];
  const payloadFields = Array.isArray(emitted.payload_fields)
    ? emitted.payload_fields.filter((field) => nonEmpty(field))
    : [];
  if (!changeKind || !addressLabel || pathLabels.length === 0 || payloadFields.length === 0) {
    throw new WaiterRowRefused(
      `Waiter ${waiterRef} declares an incomplete emitted record`,
      { waiterRef, reason: "incomplete-emitted-record" },
    );
  }
  return {
    waiter_ref: waiterRef,
    mechanism_capability_ref: mechanismRef,
    mechanism_leaf: leaf,
    mechanism_settings: row.mechanism_settings && typeof row.mechanism_settings === "object"
      ? row.mechanism_settings
      : {},
    emitted_record: {
      change_kind: changeKind,
      address_label: addressLabel,
      path_labels: pathLabels,
      payload_fields: payloadFields,
    },
    candidate_identity_feed: row.candidate_identity_feed ?? null,
    is_active: row.is_active !== false,
  };
}

/** Load the leaf a row declares and prove it is the leaf the row named.
 *
 *  Two independent refusals. The filename must be a plain leaf inside the
 *  mechanisms folder, which is what stops DATA from reaching anywhere else. The
 *  loaded module must declare the same capability reference the row declared,
 *  which is what stops a row from pointing a known capability name at a
 *  different behavior. */
export async function resolveMechanism(row, { loadModule }) {
  const declared = readWaiterRow(row);
  let mechanism;
  try {
    mechanism = await loadModule(declared.mechanism_leaf);
  } catch (error) {
    throw new WaiterRowRefused(
      `Waiter ${declared.waiter_ref} names mechanism leaf ${declared.mechanism_leaf}, which could not be loaded: ${error?.message ?? error}`,
      { waiterRef: declared.waiter_ref, reason: "mechanism-leaf-absent" },
    );
  }
  if (typeof mechanism?.describeMechanism !== "function" || typeof mechanism?.watchForTransitions !== "function") {
    throw new WaiterRowRefused(
      `Waiter ${declared.waiter_ref} names ${declared.mechanism_leaf}, which is not a mechanism leaf`,
      { waiterRef: declared.waiter_ref, reason: "not-a-mechanism-leaf" },
    );
  }
  const described = mechanism.describeMechanism();
  if (described?.mechanism_ref !== declared.mechanism_capability_ref) {
    throw new WaiterRowRefused(
      `Waiter ${declared.waiter_ref} declares ${declared.mechanism_capability_ref} but ${declared.mechanism_leaf} answers to ${described?.mechanism_ref}`,
      { waiterRef: declared.waiter_ref, reason: "mechanism-capability-mismatch" },
    );
  }
  assertNoShadowedArrivalField(described, declared.waiter_ref);
  return { declared, mechanism, described };
}

/** A mechanism may not contribute a field named like one of the owner's own.
 *
 *  Without this, a leaf could quietly overwrite matched_source_refs or sequence
 *  and every reader downstream would believe it. */
export function assertNoShadowedArrivalField(described, waiterRef) {
  const fields = Array.isArray(described?.detail_fields) ? described.detail_fields : [];
  const shadowed = fields.filter((field) => ARRIVAL_FIELDS.includes(field));
  if (shadowed.length > 0) {
    throw new WaiterRowRefused(
      `Mechanism ${described?.mechanism_ref} contributes ${shadowed.join(", ")}, which the arrival fact owns`,
      { waiterRef, reason: "shadowed-arrival-field" },
    );
  }
}

/** Evaluate one identity claim from a source descriptor's identity predicate.
 *
 *  An unknown selector root or an unknown operator is REFUSED rather than
 *  silently treated as false, because a predicate nobody can evaluate quietly
 *  matching nothing is how bytes end up under the wrong source. */
export function evaluateIdentityClaim(claim, observedIdentity) {
  const from = claim?.select?.from;
  if (from !== "observed_identity") {
    throw new Error(`An identity claim may only select from observed_identity, not ${String(from)}`);
  }
  const field = nonEmpty(claim?.select?.path);
  if (!field) throw new Error("An identity claim must name the path it selects");
  const operator = nonEmpty(claim?.operator);
  if (operator !== "op:core.equals") {
    throw new Error(`Unknown identity claim operator ${String(operator)}`);
  }
  const observed = observedIdentity?.[field];
  // A predicate that matches on an absent observation is a predicate that
  // matches everything. Absence is never a match.
  if (observed === null || observed === undefined) return false;
  return observed === claim.value;
}

/** True when every claim in the predicate holds. An empty or absent predicate
 *  never matches, because a source that declares no identity has not said which
 *  thing it is. */
export function identityMatches(predicate, observedIdentity) {
  const claims = predicate?.claims;
  if (!Array.isArray(claims) || claims.length === 0) return false;
  return claims.every((claim) => evaluateIdentityClaim(claim, observedIdentity));
}

/** Which declared sources this observation is. Possibly none, and none is a
 *  first class answer rather than an error: it is exactly the case where a
 *  thing nobody declared showed up. */
export function matchedSourceRefs(observedIdentity, candidates) {
  const matched = [];
  for (const candidate of candidates ?? []) {
    const sourceRef = nonEmpty(candidate?.source_ref);
    if (!sourceRef) continue;
    let hit = false;
    try {
      hit = identityMatches(candidate.identity_predicate, observedIdentity);
    } catch (error) {
      // One unusable predicate must not blind the emitter to every other
      // source. Say so and carry on evaluating the rest.
      console.error(
        `notice-when-something-shows-up: identity predicate for ${sourceRef} is unusable (skipping it):`,
        error?.message ?? error,
      );
      continue;
    }
    if (hit) matched.push(sourceRef);
  }
  return matched.sort();
}

/** Pull the candidate identity rows out of whatever the declared feed returned.
 *
 *  The feed is DATA. This function names no package and no property; it reads
 *  the field names the row told it to read. */
export function candidatesFromFeedEntries(entries, feed) {
  const valueField = nonEmpty(feed?.value_field) ?? "value_json";
  const predicateField = nonEmpty(feed?.predicate_field) ?? "identity_predicate";
  const sourceField = nonEmpty(feed?.source_ref_field) ?? "source_ref";
  const candidates = [];
  for (const entry of entries ?? []) {
    const payload = entry?.payload ?? entry;
    const raw = payload?.[valueField];
    let value = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (!value || typeof value !== "object") continue;
    const sourceRef = nonEmpty(value[sourceField]);
    if (!sourceRef) continue;
    candidates.push({ source_ref: sourceRef, identity_predicate: value[predicateField] ?? null });
  }
  return candidates;
}

/** The moment this observation is recorded at, floored so it never moves
 *  backward. A clock that rolls back must not be able to make a later fact
 *  claim an earlier time than an earlier fact. */
export function nextObservedAt(nowMs, previousIso) {
  const previousMs = previousIso ? Date.parse(previousIso) : Number.NaN;
  const floored = Number.isFinite(previousMs) ? Math.max(nowMs, previousMs + 1) : nowMs;
  return new Date(floored).toISOString();
}

/** Build the record payload this row declared.
 *
 *  This is the whole reason the clock survives the widening: its row projects
 *  the clock fields, a volume row projects the arrival fields, and this
 *  function has no idea which is which. Key order follows payload_fields, so a
 *  row can reproduce an existing record byte for byte. */
export function selectPayload(changeKind, payloadFields, scope) {
  const payload = { kind: changeKind };
  for (const field of payloadFields) {
    if (!(field in scope)) {
      throw new Error(`The payload field ${field} is not present in what this transition observed`);
    }
    payload[field] = scope[field];
  }
  return payload;
}

/** Assemble the value scope one transition makes available to a projection.
 *
 *  Owner fields are written last so a mechanism can never shadow one even if
 *  the contract check above were somehow bypassed. `where` (and its older name
 *  `connection`) is the vault name the run was given for what it watches (null
 *  when none), so a fact can name where its change happened. */
export function buildScope(declared, transition, { observedAt, sequence, matched, connection = null }) {
  return {
    ...(transition?.detail ?? {}),
    waiter_ref: declared.waiter_ref,
    condition: transition?.condition,
    observed_at: observedAt,
    observed_identity: transition?.observed_identity ?? {},
    matched_source_refs: matched,
    sequence,
    where: connection,
    connection,
  };
}

/** Whether a run of failures has earned a restart.
 *
 *  A loop that cannot fail cannot be restarted. Exiting is not giving up, it is
 *  the handover the supervisor exists for. A non-positive threshold turns the
 *  handover off without a code change. */
export function shouldHandOverAfterFailures(consecutiveFailures, threshold) {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  return consecutiveFailures >= threshold;
}

/** Resume a waiter's sequence from what the log already holds.
 *
 *  The predecessor owner kept its counter in a file in the machine's temporary
 *  directory, so a restart could silently reset it. The log already remembers,
 *  so nothing else needs to. A record written by the predecessor carries counter
 *  rather than sequence, and reading that is what makes the supersession
 *  continuous rather than a reset. */
export function resumeSequenceFrom(currentRecord) {
  const payload = currentRecord?.payload ?? currentRecord;
  const held = Number.isInteger(payload?.sequence)
    ? payload.sequence
    : (Number.isInteger(payload?.counter) ? payload.counter : null);
  return held === null ? 0 : held + 1;
}

// ---------------------------------------------------------------------------
// The resident part. Everything above is pure and tested without a network.
// ---------------------------------------------------------------------------

const BASIS_HEADER = "X-Bitfield-Running-Command-List-Basis";


export function makeCarrier({ url, appId, partition, fetchImpl, loadOwner = () => import("./running-app-requests.mjs") }) {
  let basis = null;
  fetchImpl ??= fetch;

  async function refreshBasis() {
    if (appId) {
      const owner = await loadOwner();
      basis = (await owner.startRunningAppSession({ appId })).basis;
      return basis;
    }
    const response = await fetchImpl(new URL("/boot", url).toString(), {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`/boot returned ${response.status}`);
    const configs = await response.json();
    const found = Array.isArray(configs) ? configs[0]?.running_command_list_basis : null;
    if (typeof found !== "string" || !found) throw new Error("/boot carries no running command list basis");
    basis = found;
    return basis;
  }

  async function operate(body, { allowRetry = true } = {}) {
    if (appId) {
      const owner = await loadOwner();
      const session = await owner.startRunningAppSession({ appId });
      return owner.sendRequestToRunningApp(session, "engine.operation.label-addressed", body);
    }
    if (!basis) await refreshBasis();
    const response = await fetchImpl(new URL("/target/engine.operation.label-addressed", url).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [BASIS_HEADER]: basis ?? "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 428 && allowRetry) {
      await refreshBasis();
      return operate(body, { allowRetry: false });
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${body.operation_label} returned ${response.status}: ${text.slice(0, 200)}`);
    return text.trim() ? JSON.parse(text) : {};
  }

  return {
    refreshBasis,
    scanUnderPath(pathLabels) {
      return operate({
        operation_label: "engine.operation.scan-current-under-path",
        partition_label: partition,
        path_labels: pathLabels,
        cursor: 0,
        limit: 1000,
      });
    },
    readCurrent(addressLabel) {
      return operate({
        operation_label: "engine.operation.read-current",
        partition_label: partition,
        address_label: addressLabel,
        address_mode: "identity_text",
      });
    },
    writeRecord({ addressLabel, pathLabels, payload }) {
      return operate({
        operation_label: "engine.operation.write-batch",
        partition_label: partition,
        writes: [{
          partition_label: partition,
          address_label: addressLabel,
          address_mode: "identity_text",
          path_labels: pathLabels,
          payload,
        }],
      });
    },
  };
}

/** Load a mechanism leaf by its plain filename, from this file's own folder.
 *
 *  The regular expression in readWaiterRow already refuses anything that is not
 *  a plain leaf name, and joining against this module's own directory is what
 *  makes the folder boundary structural rather than a convention. */
function defaultLoadModule(leafName) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return import(pathToFileURL(path.join(here, "mechanisms", leafName)).href);
}

export async function runResidentEmitter({
  env = process.env,
  carrier,
  loadModule = defaultLoadModule,
  signal,
  nowMs = () => Date.now(),
  onRefusal,
  connection = null,
} = {}) {
  const waiterPathLabels = (env.BITFIELD_ARRIVAL_WAITER_PATH
    || "packages,notice-when-something-shows-up,waiter-descriptor")
    .split(",").map((label) => label.trim()).filter(Boolean);
  const maxConsecutiveFailures = parseInt(env.BITFIELD_ARRIVAL_MAX_CONSECUTIVE_FAILURES || "10", 10);

  const scan = await carrier.scanUnderPath(waiterPathLabels);
  const rows = (scan?.entries ?? []).map((entry) => entry?.payload ?? entry).filter(Boolean);
  if (rows.length === 0) {
    throw new Error(`No waiter descriptor rows under ${waiterPathLabels.join("/")}`);
  }

  let consecutiveFailures = 0;
  const started = [];

  for (const row of rows) {
    let resolved;
    try {
      resolved = await resolveMechanism(row, { loadModule });
    } catch (error) {
      // A refused row is recorded as a fact, never swallowed. A waiter that
      // could not start is exactly a waiter that is not reachable, so it is the
      // same fact with the departure polarity and needs no new shape.
      await recordRefusal(carrier, row, error, nowMs);
      onRefusal?.(error);
      continue;
    }
    if (!resolved.declared.is_active) continue;
    started.push(startWaiter({
      carrier,
      resolved,
      signal,
      nowMs,
      connection,
      onWriteOutcome(ok) {
        if (ok) consecutiveFailures = 0;
        else consecutiveFailures += 1;
        if (shouldHandOverAfterFailures(consecutiveFailures, maxConsecutiveFailures)) {
          console.log(
            `${consecutiveFailures} appends in a row failed; exiting so the supervisor restarts this with a fresh environment`,
          );
          process.exit(0);
        }
      },
    }).catch(async (error) => {
      // A mechanism that could not wait (a place this process may not read or
      // watch, a port it may not bind) is a waiter that is not reachable. That is
      // the same fact as a refused row, and it must never take the other waiters
      // down with it: the clock keeps ticking while the volume waiter says why it
      // is not watching.
      await recordRefusal(carrier, row, Object.assign(error, { reason: error?.reason ?? "mechanism-cannot-wait" }), nowMs);
      onRefusal?.(error);
    }));
  }

  if (started.length === 0) {
    throw new Error("Every waiter descriptor row was refused or inactive; nothing is waiting");
  }
  await Promise.all(started);
}

async function recordRefusal(carrier, row, error, nowMs) {
  const waiterRef = typeof row?.id === "string" ? row.id : "waiter:unreadable-row";
  const addressLabel = typeof row?.emitted_record?.address_label === "string"
    ? row.emitted_record.address_label
    : `something-showed-up::${waiterRef}`;
  const pathLabels = Array.isArray(row?.emitted_record?.path_labels) && row.emitted_record.path_labels.length > 0
    ? row.emitted_record.path_labels
    : ["current-item", "something-showed-up"];
  try {
    await carrier.writeRecord({
      addressLabel,
      pathLabels,
      payload: {
        kind: "something-showed-up",
        waiter_ref: waiterRef,
        condition: CONDITIONS.unreachable,
        observed_at: new Date(nowMs()).toISOString(),
        observed_identity: {
          waiter_refused: true,
          refusal_reason: error?.reason ?? "refused",
          refusal_detail: String(error?.message ?? error),
        },
        matched_source_refs: [],
        sequence: 0,
      },
    });
  } catch (writeError) {
    console.error(
      "notice-when-something-shows-up: could not record a refused waiter row:",
      writeError?.message ?? writeError,
    );
  }
}

async function startWaiter({ carrier, resolved, signal, nowMs, onWriteOutcome, connection }) {
  const { declared, mechanism } = resolved;
  const emitted = declared.emitted_record;

  let current = null;
  try {
    // Kept under the waiter as well as its address: two waiters may emit at one address (every service-list and row-change
    // waiter emits at where::something-changed), and one's state read as the other's made a restarted waiter take the
    // other's list as all it had seen, so every change made while it was down was never told (Nov 19 2026).
    current = await carrier.readCurrent(emitted.address_label, declared.waiter_ref);
  } catch {
    // Nothing has ever been written at this address. Starting at the beginning
    // is the correct answer, not a failure.
    current = null;
  }
  let sequence = resumeSequenceFrom(current);
  let previousObservedAt = (current?.payload ?? current)?.observed_at ?? null;

  let candidates = [];
  const feed = declared.candidate_identity_feed;
  if (feed?.path_labels?.length) {
    try {
      const feedScan = await carrier.scanUnderPath(feed.path_labels);
      candidates = candidatesFromFeedEntries(feedScan?.entries, feed);
    } catch (error) {
      console.error(
        `notice-when-something-shows-up: could not read the candidate identity feed for ${declared.waiter_ref}:`,
        error?.message ?? error,
      );
    }
  }

  await mechanism.watchForTransitions(declared.mechanism_settings, {
    signal,
    nextSequence: sequence,
    // What this waiter kept with its last fact (a carrier with a kept folder keeps it across restarts), and a way to
    // keep more before anything is told: a mechanism's own memory, never a second store.
    state: current?.state ?? null,
    keepState: (state) => carrier.keepState?.(emitted.address_label, state, declared.waiter_ref),
    // Which switched-on wakes hear a kind of fact, as the engine lists them (a carrier over the engine's door).
    listening: (kind) => (carrier.listening ? carrier.listening(kind) : Promise.resolve([])),
    async onTransition(transition) {
      const observedAt = nextObservedAt(nowMs(), previousObservedAt);
      const matched = matchedSourceRefs(transition?.observed_identity, candidates);
      const scope = buildScope(declared, transition, { observedAt, sequence, matched, connection });
      let payload;
      try {
        payload = selectPayload(emitted.change_kind, emitted.payload_fields, scope);
      } catch (error) {
        console.error(
          `notice-when-something-shows-up: ${declared.waiter_ref} declared a projection this transition cannot satisfy:`,
          error?.message ?? error,
        );
        onWriteOutcome(false);
        return false;
      }
      try {
        // The transition's own event key (a due time's instant) names the fact, so telling it again is one fact; its
        // state is kept with it once it is told.
        await carrier.writeRecord({
          addressLabel: emitted.address_label,
          waiterRef: declared.waiter_ref,
          pathLabels: emitted.path_labels,
          payload,
          eventKey: transition?.event_key ?? null,
          state: transition?.state,
        });
        previousObservedAt = observedAt;
        sequence += 1;
        onWriteOutcome(true);
        return true;
      } catch (error) {
        console.error(
          `notice-when-something-shows-up: could not append the fact for ${declared.waiter_ref}:`,
          error?.message ?? error,
        );
        onWriteOutcome(false);
        return false;
      }
    },
  });
}

const IS_MAIN = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (IS_MAIN) {
  const { readFileSync } = await import("node:fs");
  const shell = resolveRunningShellConfig(process.env, { readFileSync });
  if (!shell) {
    console.error(
      "A stable app identity and partition are required (RUNNING_APP_APP_ID plus BITFIELD_PARTITION, or BITFIELD_TARGET_CARRIER_URL for a hosted deployment)",
    );
    process.exit(1);
  }
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection (continuing):", reason?.message ?? reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("uncaughtException (exiting for supervised restart):", error?.message ?? error);
    process.exit(1);
  });
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  runResidentEmitter({
    carrier: makeCarrier({ url: shell.url, appId: shell.appId, partition: shell.partition }),
    signal: controller.signal,
  }).catch((error) => {
    console.error("Fatal startup error:", error?.message ?? error);
    process.exit(1);
  });
}
