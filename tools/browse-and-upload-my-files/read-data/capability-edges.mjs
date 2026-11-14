// packages/live-namespace/read-data/capability-edges.mjs
//
// PURPOSE
// Admit workflow-facing capability-edge DATA for exact residual execution. An
// edge names an executable alternative, its prerequisites, output exactness,
// authority, measured-resource obligations, and fail-closed behavior.
//
// NON-NEGOTIABLE INVARIANTS
//  1. This module admits DATA only. It does not read bytes, launch work, mint
//     authority, schedule, cache, select a provider, or execute a workflow.
//  2. Exact original-byte edges must output sha256-exact immutable bytes.
//  3. Exact-result edges satisfy only their declared observable and can never
//     output or substitute for immutable bytes.
//  4. An immutable-byte optimization must retain the direct exact fallback. An
//     exact-result optimization may fall back only to an edge with the same
//     declared observable, because original bytes never satisfy a result.
//  5. Resources state an obligation to measure under the identical-snapshot
//     A/B harness and a complete per-dispatch budget contract. This module
//     normalizes DATA only; it never treats a string as measurement proof, and
//     optimized execution stays unadmitted until the harness supplies proof.

// Named for what the shape IS, never an ordinal (L206): an edge that carries its budget and
// fail-closed behavior. A different shape gets a different name, not a bigger number.
export const CAPABILITY_EDGE_SHAPE = "live-namespace.capability-edge-with-budget-and-fail-closed";
const SCHEMA_VERSION = CAPABILITY_EDGE_SHAPE;
const EDGE_ID = /^[a-z0-9][a-z0-9.-]*-[a-z0-9]+$/;
const SUBJECT_KINDS = new Set(["immutable-bytes", "exact-result"]);
const EXECUTION_MODES = new Set(["on-demand", "offline", "remote"]);
// The one resource vocabulary. The residual-demand owner imports these so a per-demand
// budget and a per-edge dispatch budget can never name different counters.
export const RESOURCE_COUNTERS = Object.freeze([
  "payload_bytes",
  "cpu_time",
  "resident_memory_bytes",
  "page_cache",
  "network_counters",
  "wall_time",
  "cancellations",
]);
export const DIRECT_EDGE_ID = "direct-exact-read";
const DISPATCH_BUDGET_OWNER = "workflow admission";
export const DISPATCH_BUDGET_POLICY =
  "finite nonnegative upper bounds for every required counter are supplied per dispatch before work; absent, non-finite, or negative values refuse dispatch";
const SOURCE_NEUTRAL_BAN = /:\/\/|@|(?:^|[\s._-])(?:credential|password|secret|api[_-]?key|recipe|derivation)(?:$|[\s._-])/i;

export class CapabilityEdgesError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CapabilityEdgesError";
    this.details = details;
  }
}

function plainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityEdgesError(`${label} must be an object`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CapabilityEdgesError(`${label} must be a plain object`, { field: label });
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Reflect.ownKeys(value).filter((field) => (
    typeof field === "symbol" || !allowed.includes(field)
  ));
  if (unknown.length !== 0) {
    throw new CapabilityEdgesError(`${label} has fields outside this exact contract`, {
      field: label,
      unknownFields: unknown.map(String).sort(),
    });
  }
}

function rejectUnknownArrayFields(value, label) {
  const unknown = Reflect.ownKeys(value).filter((field) => {
    if (typeof field === "symbol") return true;
    if (field === "length") return false;
    return typeof field !== "string" ||
      !/^\d+$/.test(field) ||
      String(Number(field)) !== field ||
      Number(field) >= value.length;
  });
  if (unknown.length !== 0) {
    throw new CapabilityEdgesError(`${label} has fields outside this exact array contract`, {
      field: label,
      unknownFields: unknown.map(String).sort(),
    });
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new CapabilityEdgesError(`${label} contains a sparse hole`, {
        field: label,
        index,
      });
    }
  }
}

function exactText(value, label, maxLength = 256) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    throw new CapabilityEdgesError(`${label} must be 1..${maxLength} exact non-whitespace characters`, {
      field: label,
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CapabilityEdgesError(`${label} contains control characters`, { field: label });
  }
  return value;
}

function jsonText(value, label, maxLength = 2048) {
  const text = exactText(value, label, maxLength);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new CapabilityEdgesError(`${label} contains control characters`, { field: label });
  }
  return text;
}

function textArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CapabilityEdgesError(`${label} must be a non-empty array`, { field: label });
  }
  rejectUnknownArrayFields(value, label);
  const output = value.map((item, index) => exactText(item, `${label}[${index}]`, 256));
  if (new Set(output).size !== output.length) {
    throw new CapabilityEdgesError(`${label} contains duplicates`, { field: label });
  }
  return output;
}

function admittedDemand(value) {
  const demand = plainObject(value, "edge.demand");
  rejectUnknownFields(demand, ["subjectKind", "observable", "range"], "edge.demand");
  const subjectKind = demand.subjectKind;
  if (!SUBJECT_KINDS.has(subjectKind)) {
    throw new CapabilityEdgesError("edge.demand.subjectKind must be immutable-bytes or exact-result", {
      field: "edge.demand.subjectKind",
    });
  }
  if (subjectKind === "immutable-bytes") {
    if (demand.observable !== undefined || demand.range !== "bounded-demand-window") {
      throw new CapabilityEdgesError(
        "an immutable-byte demand requires range bounded-demand-window and no observable substitution",
        { field: "edge.demand" },
      );
    }
    return { subjectKind, range: demand.range };
  }

  const observable = plainObject(demand.observable, "edge.demand.observable");
  rejectUnknownFields(observable, ["source", "field"], "edge.demand.observable");
  if (
    observable.source !== "content-media.relation.record" ||
    observable.field !== "role_ref"
  ) {
    throw new CapabilityEdgesError(
      "an exact-result observable must be the relation role_ref, never media type or name",
      { field: "edge.demand.observable" },
    );
  }
  if (demand.range !== undefined) {
    throw new CapabilityEdgesError("an exact-result demand must not claim a byte range", {
      field: "edge.demand.range",
    });
  }
  return { subjectKind, observable: { ...observable } };
}

function admittedPrerequisites(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CapabilityEdgesError("edge.prerequisites must be a non-empty array", {
      field: "edge.prerequisites",
    });
  }
  rejectUnknownArrayFields(value, "edge.prerequisites");
  return value.map((item, index) => {
    const label = `edge.prerequisites[${index}]`;
    const prerequisite = plainObject(item, label);
    rejectUnknownFields(prerequisite, ["kind", "owner", "description"], label);
    return {
      kind: exactText(prerequisite.kind, `${label}.kind`, 128),
      owner: exactText(prerequisite.owner, `${label}.owner`, 256),
      description: jsonText(prerequisite.description, `${label}.description`, 1024),
    };
  });
}

function admittedExecution(value) {
  const execution = plainObject(value, "edge.execution");
  rejectUnknownFields(execution, ["owner", "workflow_target", "mode"], "edge.execution");
  const mode = execution.mode;
  if (!EXECUTION_MODES.has(mode)) {
    throw new CapabilityEdgesError("edge.execution.mode is invalid", { field: "edge.execution.mode" });
  }
  const owner = jsonText(execution.owner, "edge.execution.owner", 256);
  const workflowTarget = jsonText(execution.workflow_target, "edge.execution.workflow_target", 256);
  for (const text of [owner, workflowTarget]) {
    if (SOURCE_NEUTRAL_BAN.test(text)) {
      throw new CapabilityEdgesError("execution owner/target must stay source-neutral", {
        field: "edge.execution",
      });
    }
  }
  return {
    owner,
    workflowTarget,
    mode,
  };
}

function admittedOutputs(value, demand) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new CapabilityEdgesError("edge.outputs must contain exactly one output", {
      field: "edge.outputs",
    });
  }
  rejectUnknownArrayFields(value, "edge.outputs");
  const output = plainObject(value[0], "edge.outputs[0]");
  rejectUnknownFields(output, ["kind", "equality", "observable"], "edge.outputs[0]");
  if (demand.subjectKind === "immutable-bytes") {
    if (
      output.kind !== "immutable-bytes" ||
      output.equality !== "sha256-exact" ||
      output.observable !== undefined
    ) {
      throw new CapabilityEdgesError(
        "an immutable-byte edge must output sha256-exact immutable bytes only",
        { field: "edge.outputs[0]" },
      );
    }
    return [{ kind: output.kind, equality: output.equality }];
  }

  const observable = plainObject(output.observable, "edge.outputs[0].observable");
  rejectUnknownFields(observable, ["source", "field"], "edge.outputs[0].observable");
  if (
    output.kind !== "exact-result" ||
    output.equality !== "declared-observable-only" ||
    observable.source !== demand.observable.source ||
    observable.field !== demand.observable.field
  ) {
    throw new CapabilityEdgesError(
      "an exact-result edge must output only its declared observable",
      { field: "edge.outputs[0]" },
    );
  }
  return [{ kind: output.kind, equality: output.equality, observable: { ...observable } }];
}

function admittedAuthority(value) {
  const authority = plainObject(value, "edge.authority");
  rejectUnknownFields(authority, ["required", "prohibited"], "edge.authority");
  const required = textArray(authority.required, "edge.authority.required");
  const prohibited = textArray(authority.prohibited, "edge.authority.prohibited");
  const contradiction = required.filter((item) => prohibited.includes(item)).sort();
  if (contradiction.length !== 0) {
    throw new CapabilityEdgesError("an edge cannot require and prohibit the same authority", {
      field: "edge.authority",
      contradiction,
    });
  }
  return { required, prohibited };
}

function admittedDispatchBudget(value, optimized) {
  if (value === undefined) {
    if (optimized) {
      throw new CapabilityEdgesError("an optimized edge must declare its per-dispatch budget contract", {
        field: "edge.resources.dispatch_budget",
      });
    }
    return null;
  }
  const budget = plainObject(value, "edge.resources.dispatch_budget");
  rejectUnknownFields(
    budget,
    ["owner", "required", "value_rule"],
    "edge.resources.dispatch_budget",
  );
  if (budget.owner !== DISPATCH_BUDGET_OWNER) {
    throw new CapabilityEdgesError("dispatch budget owner mismatch", {
      field: "edge.resources.dispatch_budget.owner",
      expected: DISPATCH_BUDGET_OWNER,
    });
  }
  const required = textArray(budget.required, "edge.resources.dispatch_budget.required");
  const missing = RESOURCE_COUNTERS.filter((counter) => !required.includes(counter));
  const unknown = required.filter((counter) => !RESOURCE_COUNTERS.includes(counter));
  if (missing.length !== 0 || unknown.length !== 0) {
    throw new CapabilityEdgesError("edge.resources.dispatch_budget.required is incomplete", {
      field: "edge.resources.dispatch_budget.required",
      missing: missing.sort(),
      unknown: unknown.sort(),
    });
  }
  if (budget.value_rule !== DISPATCH_BUDGET_POLICY) {
    throw new CapabilityEdgesError("dispatch budget value rule mismatch", {
      field: "edge.resources.dispatch_budget.value_rule",
      expected: DISPATCH_BUDGET_POLICY,
    });
  }
  return { owner: budget.owner, required, valueRule: budget.value_rule };
}

function admittedResources(value, optimized) {
  const resources = plainObject(value, "edge.resources");
  rejectUnknownFields(
    resources,
    ["measurement_method", "execution_admitted", "counters", "dispatch_budget"],
    "edge.resources",
  );
  if (resources.measurement_method !== "identical-snapshot-ab") {
    throw new CapabilityEdgesError(
      "resources require the identical-snapshot A/B measurement method",
      { field: "edge.resources.measurement_method" },
    );
  }
  if (resources.execution_admitted !== false) {
    throw new CapabilityEdgesError(
      "this DATA owner cannot admit optimized execution before measurement proof",
      { field: "edge.resources.execution_admitted" },
    );
  }
  const counters = textArray(resources.counters, "edge.resources.counters");
  const missing = RESOURCE_COUNTERS.filter((counter) => !counters.includes(counter));
  const unknown = counters.filter((counter) => !RESOURCE_COUNTERS.includes(counter));
  if (missing.length !== 0 || unknown.length !== 0) {
    throw new CapabilityEdgesError("edge.resources.counters is incomplete", {
      field: "edge.resources.counters",
      missing: missing.sort(),
      unknown: unknown.sort(),
    });
  }
  return {
    measurementMethod: resources.measurement_method,
    executionAdmitted: resources.execution_admitted,
    counters,
    dispatchBudget: admittedDispatchBudget(resources.dispatch_budget, optimized),
  };
}

function admittedFailure(value) {
  const failure = plainObject(value, "edge.failure");
  rejectUnknownFields(failure, ["mode", "fallback_edge", "success_states"], "edge.failure");
  if (failure.mode !== "fail-closed") {
    throw new CapabilityEdgesError("edge.failure.mode must be fail-closed", {
      field: "edge.failure.mode",
    });
  }
  if (failure.fallback_edge !== null && typeof failure.fallback_edge !== "string") {
    throw new CapabilityEdgesError("edge.failure.fallback_edge must name an edge or null", {
      field: "edge.failure.fallback_edge",
    });
  }
  return {
    mode: failure.mode,
    fallbackEdge: failure.fallback_edge,
    successStates: textArray(failure.success_states, "edge.failure.success_states"),
  };
}

function admittedEdge(value) {
  const edge = plainObject(value, "edge");
  rejectUnknownFields(
    edge,
    ["kind", "edge_id", "summary", "demand", "prerequisites", "execution", "outputs", "authority", "resources", "failure"],
    "edge",
  );
  if (edge.kind !== "live-namespace.capability-edge") {
    throw new CapabilityEdgesError("edge kind mismatch", {
      expected: "live-namespace.capability-edge",
      received: edge.kind,
    });
  }
  const edgeId = exactText(edge.edge_id, "edge.edge_id", 128);
  if (!EDGE_ID.test(edgeId)) {
    throw new CapabilityEdgesError("edge.edge_id must be a stable lowercase hyphen id", {
      field: "edge.edge_id",
    });
  }
  const demand = admittedDemand(edge.demand);
  const optimized = edgeId !== DIRECT_EDGE_ID;
  return {
    edgeId,
    summary: jsonText(edge.summary, "edge.summary", 512),
    demand,
    prerequisites: admittedPrerequisites(edge.prerequisites),
    execution: admittedExecution(edge.execution),
    outputs: admittedOutputs(edge.outputs, demand),
    authority: admittedAuthority(edge.authority),
    resources: admittedResources(edge.resources, optimized),
    failure: admittedFailure(edge.failure),
  };
}

function validateFallbacks(edges) {
  const byId = new Map(edges.map((edge) => [edge.edgeId, edge]));
  const direct = byId.get(DIRECT_EDGE_ID);
  if (!direct) {
    throw new CapabilityEdgesError("the direct exact fallback edge is required", {
      field: "edges",
      missingEdgeId: DIRECT_EDGE_ID,
    });
  }
  if (
    direct.demand.subjectKind !== "immutable-bytes" ||
    direct.demand.range !== "bounded-demand-window" ||
    direct.outputs.length !== 1 ||
    direct.outputs[0].kind !== "immutable-bytes" ||
    direct.outputs[0].equality !== "sha256-exact"
  ) {
    throw new CapabilityEdgesError("direct-exact-read must remain an immutable-byte edge", {
      edgeId: direct.edgeId,
    });
  }
  for (const edge of edges) {
    if (edge === direct) {
      if (edge.failure.fallbackEdge !== null) {
        throw new CapabilityEdgesError("the direct exact edge cannot fall back to itself", {
          edgeId: edge.edgeId,
        });
      }
      continue;
    }
    if (edge.demand.subjectKind === "immutable-bytes") {
      if (edge.failure.fallbackEdge !== DIRECT_EDGE_ID) {
        throw new CapabilityEdgesError("every immutable-byte optimization must retain the direct exact fallback", {
          edgeId: edge.edgeId,
          fallbackEdge: edge.failure.fallbackEdge,
        });
      }
      continue;
    }
    if (edge.failure.fallbackEdge === null) continue;

    const fallback = byId.get(edge.failure.fallbackEdge);
    if (!fallback || fallback === direct) {
      throw new CapabilityEdgesError(
        "an exact-result edge may fall back only to an edge with the same declared observable",
        {
          edgeId: edge.edgeId,
          fallbackEdge: edge.failure.fallbackEdge,
        },
      );
    }
    if (
      fallback.demand.subjectKind !== edge.demand.subjectKind ||
      fallback.demand.observable?.source !== edge.demand.observable?.source ||
      fallback.demand.observable?.field !== edge.demand.observable?.field ||
      fallback.outputs[0]?.kind !== edge.outputs[0]?.kind ||
      fallback.outputs[0]?.equality !== edge.outputs[0]?.equality ||
      fallback.outputs[0]?.observable?.source !== edge.outputs[0]?.observable?.source ||
      fallback.outputs[0]?.observable?.field !== edge.outputs[0]?.observable?.field
    ) {
      throw new CapabilityEdgesError("fallback demand and output must satisfy the same exact subject", {
        edgeId: edge.edgeId,
        fallbackEdge: fallback.edgeId,
      });
    }

    const fallbackChain = new Set([edge.edgeId]);
    let cursor = fallback;
    while (cursor.failure.fallbackEdge !== null) {
      if (fallbackChain.has(cursor.edgeId)) {
        throw new CapabilityEdgesError("capability fallback cycle", {
          edgeId: edge.edgeId,
          cycleStart: cursor.edgeId,
        });
      }
      fallbackChain.add(cursor.edgeId);
      const next = byId.get(cursor.failure.fallbackEdge);
      if (!next) {
        throw new CapabilityEdgesError("fallback edge does not exist", {
          edgeId: cursor.edgeId,
          fallbackEdge: cursor.failure.fallbackEdge,
        });
      }
      cursor = next;
    }
  }
}

function validateAuthority(edges) {
  for (const edge of edges) {
    if (
      edge.edgeId === DIRECT_EDGE_ID &&
      !edge.authority.required.includes("exact-byte-transfer")
    ) {
      throw new CapabilityEdgesError("the direct exact edge requires exact-byte-transfer authority", {
        edgeId: edge.edgeId,
      });
    }
    if (
      edge.demand.subjectKind === "exact-result" &&
      !edge.authority.required.includes("artifact-read")
    ) {
      throw new CapabilityEdgesError("exact-result edges require artifact-read authority", {
        edgeId: edge.edgeId,
      });
    }
  }
}

/**
 * Normalize and validate workflow-facing capability-edge DATA.
 * The input is not mutated and no runtime work is dispatched.
 */
export function capabilityEdgesFromData(input) {
  const request = plainObject(input, "capability edges");
  rejectUnknownFields(request, ["schemaVersion", "edges"], "capability edges");
  if (request.schemaVersion !== SCHEMA_VERSION) {
    throw new CapabilityEdgesError("capability-edge schema version mismatch", {
      expected: SCHEMA_VERSION,
      received: request.schemaVersion,
    });
  }
  if (!Array.isArray(request.edges) || request.edges.length === 0) {
    throw new CapabilityEdgesError("edges must be a non-empty array", { field: "edges" });
  }
  rejectUnknownArrayFields(request.edges, "edges");

  const admitted = request.edges.map(admittedEdge);
  const unique = new Map();
  for (const edge of admitted) {
    if (unique.has(edge.edgeId)) {
      throw new CapabilityEdgesError("duplicate edge_id", { edgeId: edge.edgeId });
    }
    unique.set(edge.edgeId, edge);
  }
  validateFallbacks(admitted);
  validateAuthority(admitted);
  const edges = [...unique.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  return {
    kind: "live-namespace.capability-edge-set",
    schemaVersion: SCHEMA_VERSION,
    directFallbackEdgeId: DIRECT_EDGE_ID,
    edges,
    summary: {
      supplied: request.edges.length,
      normalized: edges.length,
      dataContractComplete: true,
      executionAdmitted: false,
    },
  };
}
