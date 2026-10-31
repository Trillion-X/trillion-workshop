// tools/evaluate-progress/read-data/derive-measure.ts
// One reducer for every measure: a measure definition names an op, the fact windows it reads (a selector is a match map and a field path array) and the op params.
// The op comes from the op map handed in, never from a switch here. A missing or throwing op gives a measure with ok:false and confidence 0, never a thrown error or a made-up number.


export type FactRecord = Record<string, unknown> & { id?: string };

export type FactSelector = {
  match?: Record<string, unknown>;
  field?: string[];
};

export type SelectedInput = {
  facts: FactRecord[];
  selector: FactSelector;
};

export type MeasureOpResult = {
  value: unknown;
  confidence?: number;
  basis?: string[];
};

export type MeasureOp = (inputs: SelectedInput[], params: Record<string, unknown>) => MeasureOpResult;

export type OpMap = Record<string, MeasureOp>;

export type MeasureDefinition = {
  id: string;
  op: string;
  inputs?: FactSelector[];
  params?: Record<string, unknown>;
  window?: unknown;
  emit?: string;
  failClosed?: boolean;
};

export type MeasureProvenance = {
  op: string;
  inputCount: number;
};

export type MeasureFact = {
  measureId: string;
  emit: string | null;
  value: unknown;
  window: unknown;
  provenance: MeasureProvenance[];
  confidence: number;
  basis: string[];
  ok: boolean;
  error?: string;
};

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function selectFacts(facts: FactRecord[], selector: FactSelector): FactRecord[] {
  const match = selector.match;
  if (!match || Object.keys(match).length === 0) return facts.slice();
  return facts.filter((f) =>
    Object.entries(match).every(([k, v]) => deepEquals((f as Record<string, unknown>)[k], v))
  );
}

function failClosedFact(def: MeasureDefinition, error: string): MeasureFact {
  return {
    measureId: def.id,
    emit: typeof def.emit === "string" ? def.emit : null,
    value: null,
    window: def.window ?? null,
    provenance: [{ op: def.op, inputCount: 0 }],
    confidence: 0,
    basis: [],
    ok: false,
    error,
  };
}

export function deriveMeasure(
  facts: FactRecord[],
  def: MeasureDefinition,
  opMap: OpMap
): MeasureFact {
  const allFacts = Array.isArray(facts) ? facts : [];
  const failClosed = def.failClosed !== false;
  const op = opMap ? opMap[def.op] : undefined;

  const inputs: SelectedInput[] = (def.inputs ?? []).map((selector) => ({
    facts: selectFacts(allFacts, selector),
    selector,
  }));
  const inputCount = inputs.reduce((n, i) => n + i.facts.length, 0);

  if (typeof op !== "function") {
    return failClosedFact(def, `op_not_in_opmap:${def.op}`);
  }

  try {
    const result = op(inputs, def.params ?? {});
    return {
      measureId: def.id,
      emit: typeof def.emit === "string" ? def.emit : null,
      value: result.value,
      window: def.window ?? null,
      provenance: [{ op: def.op, inputCount }],
      confidence: typeof result.confidence === "number" ? result.confidence : 1,
      basis: Array.isArray(result.basis) ? result.basis : [],
      ok: true,
    };
  } catch (e) {
    if (failClosed) return failClosedFact(def, `op_threw:${String((e as Error)?.message ?? e)}`);
    throw e;
  }
}

export function deriveMeasures(
  facts: FactRecord[],
  defs: MeasureDefinition[],
  opMap: OpMap
): MeasureFact[] {
  return (Array.isArray(defs) ? defs : []).map((def) => deriveMeasure(facts, def, opMap));
}
