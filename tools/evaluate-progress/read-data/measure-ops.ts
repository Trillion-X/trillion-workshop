// tools/evaluate-progress/read-data/measure-ops.ts
// The op catalog: each op reduces the fact windows a definition selects, with the definition params, to a value plus confidence and the ids of the facts it read.
// Ops are chosen by the definition (DATA) and name no field, word or domain; params and field paths come from the definition. README.md lists each op and its params.


import type { MeasureOp, OpMap, SelectedInput, FactRecord } from './derive-measure.ts';
import { getPath } from './get-path.ts';
import { bandPayloadOf, type Band } from './band-membership.ts';

function numbersOf(input: SelectedInput | undefined): number[] {
  if (!input) return [];
  const out: number[] = [];
  for (const f of input.facts) {
    const raw = getPath(f, input.selector.field);
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function basisOf(inputs: SelectedInput[]): string[] {
  const ids: string[] = [];
  for (const i of inputs) for (const f of i.facts) if (typeof f.id === "string") ids.push(f.id);
  return ids;
}

const countOp: MeasureOp = (inputs) => ({
  value: inputs[0]?.facts.length ?? 0,
  basis: basisOf(inputs),
});

const sumOp: MeasureOp = (inputs) => ({
  value: numbersOf(inputs[0]).reduce((a, b) => a + b, 0),
  basis: basisOf(inputs),
});

const distinctOp: MeasureOp = (inputs) => {
  const set = new Set<unknown>();
  for (const f of inputs[0]?.facts ?? []) set.add(getPath(f, inputs[0].selector.field));
  return { value: set.size, basis: basisOf(inputs) };
};

const ratioOp: MeasureOp = (inputs, params) => {
  const mode = params.mode === "sum" ? "sum" : "count";
  const reduce = (i: SelectedInput | undefined) =>
    mode === "sum" ? numbersOf(i).reduce((a, b) => a + b, 0) : i?.facts.length ?? 0;
  const num = reduce(inputs[0]);
  const den = reduce(inputs[1]);
  if (den === 0) return { value: 0, confidence: 0, basis: basisOf(inputs) };
  return { value: num / den, basis: basisOf(inputs) };
};

const binOp: MeasureOp = (inputs, params) => {
  const edges = Array.isArray(params.edges) ? (params.edges as number[]) : [];
  const counts = new Array(Math.max(0, edges.length - 1)).fill(0);
  for (const v of numbersOf(inputs[0])) {
    for (let i = 0; i < edges.length - 1; i++) {
      if (v >= edges[i] && v < edges[i + 1]) {
        counts[i]++;
        break;
      }
    }
  }
  return { value: { counts }, basis: basisOf(inputs) };
};

const bandOp: MeasureOp = (inputs, params) => {
  const bands = Array.isArray(params.bands) ? (params.bands as Array<Band>) : [];
  const values = numbersOf(inputs[0]);
  const value = values.length ? values[values.length - 1] : NaN;
  const payload = bandPayloadOf(value, bands);
  if (payload === undefined) return { value: null, confidence: 0, basis: basisOf(inputs) };
  return { value: payload, basis: basisOf(inputs) };
};

const rankOp: MeasureOp = (inputs, params) => {
  const input = inputs[0];
  const facts = (input?.facts ?? []).slice();
  const valueOf = (f: FactRecord) => {
    const raw = getPath(f, input?.selector.field);
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
  };
  const sign = params.ascending ? 1 : -1;
  facts.sort((a, b) => sign * (valueOf(a) - valueOf(b)));
  return { value: facts.map((f) => (typeof f.id === "string" ? f.id : null)), basis: basisOf(inputs) };
};

const latestOp: MeasureOp = (inputs, params) => {
  const sortBy = params.sortBy;
  if (!Array.isArray(sortBy) || sortBy.length === 0 || !sortBy.every((part) => typeof part === "string")) {
    throw new Error("latest needs params.sortBy: the path (a list of names) of the field that says which record is latest");
  }
  const input = inputs[0];
  const facts = input?.facts ?? [];
  if (facts.length === 0) return { value: null, confidence: 0, basis: basisOf(inputs) };
  const cmp = (a: unknown, b: unknown): number => {
    const na = typeof a === "number" ? a : Number(a);
    const nb = typeof b === "number" ? b : Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
    const sa = a == null ? "" : String(a);
    const sb = b == null ? "" : String(b);
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  };
  let best = facts[0];
  let bestKey = getPath(best, sortBy);
  for (let i = 1; i < facts.length; i++) {
    const k = getPath(facts[i], sortBy);
    if (cmp(k, bestKey) >= 0) { best = facts[i]; bestKey = k; }
  }
  const value = getPath(best, input?.selector.field);
  return { value: value ?? null, basis: basisOf(inputs) };
};

const angleOp: MeasureOp = (inputs) => {
  const pt = (i: number): number[] => {
    const input = inputs[i];
    const raw = getPath(input?.facts[0], input?.selector.field);
    return Array.isArray(raw) ? (raw as number[]).map(Number) : [];
  };
  const [a, b, c] = [pt(0), pt(1), pt(2)];
  if (a.length < 2 || b.length < 2 || c.length < 2) return { value: null, confidence: 0, basis: basisOf(inputs) };
  const dims = Math.min(a.length, b.length, c.length);
  const ba: number[] = [];
  const bc: number[] = [];
  for (let d = 0; d < dims; d++) {
    ba.push(a[d] - b[d]);
    bc.push(c[d] - b[d]);
  }
  const dot = ba.reduce((s, v, d) => s + v * bc[d], 0);
  const mag = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const denom = mag(ba) * mag(bc);
  if (denom === 0) return { value: null, confidence: 0, basis: basisOf(inputs) };
  const cos = Math.max(-1, Math.min(1, dot / denom));
  return { value: (Math.acos(cos) * 180) / Math.PI, basis: basisOf(inputs) };
};

const reduceGraphOp: MeasureOp = (inputs, params) => {
  const graph = (params.graph ?? {}) as {
    start?: unknown;
    transitions?: Array<{ from: unknown; on: unknown; to: unknown }>;
  };
  const eventField = Array.isArray(params.eventField) ? (params.eventField as string[]) : ["event"];
  const transitions = Array.isArray(graph.transitions) ? graph.transitions : [];
  let state = graph.start;
  const path: unknown[] = [state];
  for (const f of inputs[0]?.facts ?? []) {
    const symbol = getPath(f, eventField);
    const t = transitions.find(
      (tr) =>
        JSON.stringify(tr.from) === JSON.stringify(state) &&
        JSON.stringify(tr.on) === JSON.stringify(symbol)
    );
    if (t) {
      state = t.to;
      path.push(state);
    }
  }
  return { value: { state, path }, basis: basisOf(inputs) };
};

const rollupOp: MeasureOp = (inputs, params) => {
  const input = inputs[0];
  const facts = input?.facts ?? [];
  const groupBy = Array.isArray(params.groupBy) ? (params.groupBy as string[]) : [];
  const mode = params.reduce === "sum" ? "sum" : params.reduce === "avg" ? "avg" : "count";
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const f of facts) {
    const rawKey = getPath(f, groupBy);
    const key = typeof rawKey === "string" ? rawKey : JSON.stringify(rawKey ?? null);
    if (!counts.has(key)) {
      order.push(key);
      counts.set(key, 0);
      sums.set(key, 0);
    }
    counts.set(key, (counts.get(key) as number) + 1);
    const raw = getPath(f, input?.selector.field);
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) sums.set(key, (sums.get(key) as number) + n);
  }
  const groups: Record<string, number> = {};
  for (const key of order) {
    const c = counts.get(key) as number;
    const s = sums.get(key) as number;
    groups[key] = mode === "count" ? c : mode === "sum" ? s : c === 0 ? 0 : s / c;
  }
  return { value: { groups, keys: order }, basis: basisOf(inputs) };
};

type FormulaReduce = "count" | "sum" | "mean" | "variance" | "stdev" | "min" | "max";
type FormulaNode =
  | { const: number }
  | { input: number; reduce?: FormulaReduce }
  | { recode: number; map: Record<string, number>; default?: number }
  | { op: "add" | "sub" | "mul" | "div"; args: FormulaNode[] };

function reduceNumbers(nums: readonly number[], reduce: FormulaReduce | undefined): number {
  if (reduce === "sum") return nums.reduce((a, b) => a + b, 0);
  if (!reduce || reduce === "count") return nums.length;
  if (nums.length === 0) return NaN;
  if (reduce === "min") return Math.min(...nums);
  if (reduce === "max") return Math.max(...nums);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (reduce === "mean") return mean;
  const variance = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nums.length;
  return reduce === "stdev" ? Math.sqrt(variance) : variance;
}

function firstRawKey(input: SelectedInput | undefined): string | null {
  const f = input?.facts[0];
  if (!f) return null;
  const raw = getPath(f, input!.selector.field);
  return raw == null ? null : String(raw);
}

const evalFormula = (node: FormulaNode | undefined, inputs: SelectedInput[]): number => {
  if (!node || typeof node !== "object") return NaN;
  if ("const" in node) return Number((node as { const: number }).const);
  if ("input" in node) {
    const i = (node as { input: number }).input;
    const reduce = (node as { reduce?: FormulaReduce }).reduce;
    if (!reduce || reduce === "count") return inputs[i]?.facts.length ?? 0;
    return reduceNumbers(numbersOf(inputs[i]), reduce);
  }
  if ("recode" in node) {
    const n = node as { recode: number; map: Record<string, number>; default?: number };
    const key = firstRawKey(inputs[n.recode]);
    const map = n.map && typeof n.map === "object" ? n.map : {};
    const mapped = key != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    return typeof mapped === "number" ? mapped : typeof n.default === "number" ? n.default : NaN;
  }
  const op = (node as { op: string }).op;
  const args = Array.isArray((node as { args?: FormulaNode[] }).args) ? (node as { args: FormulaNode[] }).args : [];
  const vals = args.map((a) => evalFormula(a, inputs));
  if (vals.length === 0) return NaN;
  switch (op) {
    case "add": return vals.reduce((a, b) => a + b, 0);
    case "sub": return vals.reduce((a, b) => a - b);
    case "mul": return vals.reduce((a, b) => a * b, 1);
    case "div": return vals.reduce((a, b) => (b === 0 ? NaN : a / b));
    default: return NaN;
  }
};
const formulaOp: MeasureOp = (inputs, params) => {
  const result = evalFormula(params.expr as FormulaNode | undefined, inputs);
  if (!Number.isFinite(result)) return { value: null, confidence: 0, basis: basisOf(inputs) };
  return { value: result, basis: basisOf(inputs) };
};

const weightedRankOp: MeasureOp = (inputs, params) => {
  const facts = inputs[0]?.facts ?? [];
  const weights = (params.weights && typeof params.weights === "object" ? params.weights : {}) as Record<string, number>;
  const scored = facts.map((f) => {
    let score = 0;
    let factor: string | null = null;
    let bestContribution = -Infinity;
    for (const field of Object.keys(weights)) {
      const w = weights[field];
      const raw = getPath(f, [field]);
      const n = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(n) && Number.isFinite(w)) {
        const contribution = (w as number) * n;
        score += contribution;
        if (contribution > bestContribution) { bestContribution = contribution; factor = field; }
      }
    }
    return { id: typeof f.id === "string" ? f.id : null, score, factor };
  });
  const sign = params.ascending ? -1 : 1; // default descending: best (highest score) first
  scored.sort((a, b) => sign * (b.score - a.score));
  const limited = typeof params.limit === "number" && params.limit >= 0 ? scored.slice(0, params.limit) : scored;
  const scores: Record<string, number> = {};
  for (const s of scored) if (s.id != null) scores[s.id] = s.score;
  return { value: { ranked: limited, top: limited[0]?.id ?? null, scores }, basis: basisOf(inputs) };
};

const quantileOp: MeasureOp = (inputs, params) => {
  const nums = numbersOf(inputs[0]).slice().sort((a, b) => a - b);
  if (nums.length === 0) return { value: null, confidence: 0, basis: basisOf(inputs) };
  let q =
    params.reduce === "max" ? 1 :
    params.reduce === "min" ? 0 :
    Number.isFinite(params.q) ? (params.q as number) : 0.5;
  q = Math.min(1, Math.max(0, q));
  const pos = q * (nums.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const value = nums[lo] + (pos - lo) * (nums[hi] - nums[lo]);
  return { value, basis: basisOf(inputs) };
};

const deriveSpansOp: MeasureOp = (inputs, params) => {
  const input = inputs[0];
  const facts = input?.facts ?? [];
  const timeField = (params.timeField as string[]) ?? ["t"];
  const timeUnit = params.timeUnit === "frame" ? "frame" : "second";
  const fps = Number.isFinite(params.fps) ? (params.fps as number) : 0;
  const preS = Number.isFinite(params.preS) ? (params.preS as number) : 0;
  const postS = Number.isFinite(params.postS) ? (params.postS as number) : 0;
  const scoreField = (params.scoreField as string[]) ?? ["score"];
  const scoreScale = Number.isFinite(params.scoreScale) ? (params.scoreScale as number) : 1;
  const clamp = Array.isArray(params.scoreClamp) ? (params.scoreClamp as number[]) : null;
  const category = typeof params.category === "string" ? params.category : "";
  const minScore = Number.isFinite(params.minScore) ? (params.minScore as number) : Number.NEGATIVE_INFINITY;

  const num = (f: FactRecord, path: string[]): number => {
    const raw = getPath(f, path);
    return typeof raw === "number" ? raw : Number(raw);
  };

  const out: Array<{ id: string | null; start: number; end: number; score: number; category: string }> = [];
  for (const f of facts) {
    const rawT = num(f, timeField);
    let rawScore = num(f, scoreField);
    if (!Number.isFinite(rawT) || !Number.isFinite(rawScore)) continue;
    if (timeUnit === "frame" && !(fps > 0)) continue;
    const seconds = timeUnit === "frame" ? rawT / fps : rawT;
    let score = rawScore * scoreScale;
    if (clamp && clamp.length === 2) score = Math.min(clamp[1], Math.max(clamp[0], score));
    if (score < minScore) continue;
    out.push({
      id: typeof f.id === "string" ? f.id : null,
      start: Math.max(0, +(seconds - preS).toFixed(4)),
      end: +(seconds + postS).toFixed(4),
      score,
      category,
    });
  }
  return { value: out, confidence: out.length > 0 ? 1 : 0, basis: basisOf(inputs) };
};

const constrainedSpanPackOp: MeasureOp = (inputs, params) => {
  const input = inputs[0];
  const facts = input?.facts ?? [];
  const startField = (params.startField as string[]) ?? ["start"];
  const endField = (params.endField as string[]) ?? ["end"];
  const scoreField = (params.scoreField as string[]) ?? ["score"];
  const categoryField = params.categoryField as string[] | undefined;
  const mergeGapS = Number.isFinite(params.mergeGapS) ? (params.mergeGapS as number) : 0;
  const maxMergedDurationS = Number.isFinite(params.maxMergedDurationS) ? (params.maxMergedDurationS as number) : Number.POSITIVE_INFINITY;
  const perCategoryQuota = (params.perCategoryQuota as Record<string, number>) ?? {};
  const defaultQuota = Number.isFinite(params.defaultQuota) ? (params.defaultQuota as number) : Number.POSITIVE_INFINITY;
  const maxDurationS = Number.isFinite(params.maxDurationS) ? (params.maxDurationS as number) : Number.POSITIVE_INFINITY;
  const maxCount = Number.isFinite(params.maxCount) ? (params.maxCount as number) : Number.POSITIVE_INFINITY;
  const sign = params.ascending ? 1 : -1;

  const num = (f: FactRecord, path: string[]): number => {
    const raw = getPath(f, path);
    return typeof raw === "number" ? raw : Number(raw);
  };

  type Cand = { id: string | null; start: number; end: number; score: number; category: string; members: string[] };
  const rejected: Array<{ id: string | null; reason: string }> = [];
  const cands: Cand[] = [];
  for (const f of facts) {
    const start = num(f, startField);
    const end = num(f, endField);
    const score = num(f, scoreField);
    const id = typeof f.id === "string" ? f.id : null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(score)) {
      rejected.push({ id, reason: "invalid-span" });
      continue;
    }
    const category = categoryField ? String(getPath(f, categoryField) ?? "") : "";
    cands.push({ id, start, end, score, category, members: id ? [id] : [] });
  }

  let merged: Cand[];
  if (mergeGapS > 0) {
    merged = [];
    for (const c of cands.slice().sort((a, b) => a.start - b.start)) {
      const prev = merged[merged.length - 1];
      if (prev && c.category === prev.category && c.start - prev.end <= mergeGapS && Math.max(prev.end, c.end) - prev.start <= maxMergedDurationS) {
        prev.end = Math.max(prev.end, c.end);
        prev.score = Math.max(prev.score, c.score);
        prev.members = prev.members.concat(c.members);
      } else {
        merged.push({ ...c, members: c.members.slice() });
      }
    }
  } else {
    merged = cands;
  }

  const order = merged.slice().sort((a, b) => sign * (a.score - b.score));
  const selected: Cand[] = [];
  const catCount: Record<string, number> = {};
  let totalDurationS = 0;
  for (const c of order) {
    if (selected.length >= maxCount) { rejected.push({ id: c.id, reason: "max-count" }); continue; }
    if (selected.some((s) => c.start < s.end && s.start < c.end)) { rejected.push({ id: c.id, reason: "overlap" }); continue; }
    const quota = Number.isFinite(perCategoryQuota[c.category]) ? perCategoryQuota[c.category] : defaultQuota;
    if ((catCount[c.category] ?? 0) >= quota) { rejected.push({ id: c.id, reason: "quota" }); continue; }
    const dur = c.end - c.start;
    if (totalDurationS + dur > maxDurationS) { rejected.push({ id: c.id, reason: "duration-budget" }); continue; }
    selected.push(c);
    catCount[c.category] = (catCount[c.category] ?? 0) + 1;
    totalDurationS += dur;
  }

  const value = {
    selected: selected
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ id: c.id, start: c.start, end: c.end, score: c.score, category: c.category, members: c.members })),
    rejected,
    totalDurationS: +totalDurationS.toFixed(4),
    strategy: "greedy-by-score",
  };
  return { value, confidence: selected.length > 0 ? 1 : 0, basis: basisOf(inputs) };
};

const relevanceRankOp: MeasureOp = (inputs, params) => {
  const facts = inputs[0]?.facts ?? [];
  const scoreFieldPath = Array.isArray(params.scoreField) ? (params.scoreField as unknown[]) : null;

  const queryTerms = Array.isArray(params.queryTerms) ? params.queryTerms : [];
  const query = new Set(
    queryTerms
      .filter((t): t is string => typeof t === "string")
      .flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/i))
      .filter((t) => t.length > 0)
  );
  const candidateFields = Array.isArray(params.candidateFields)
    ? (params.candidateFields as unknown[]).filter((p) => Array.isArray(p))
    : [];
  const weights = Array.isArray(params.weights) ? params.weights : [];

  const tokensAt = (f: FactRecord, path: unknown): Set<string> => {
    const raw = getPath(f, path as (string | number)[]);
    const out = new Set<string>();
    const add = (s: string) => { for (const tok of s.toLowerCase().split(/[^a-z0-9]+/i)) if (tok) out.add(tok); };
    if (typeof raw === "string") add(raw);
    else if (Array.isArray(raw)) for (const el of raw) if (typeof el === "string") add(el);
    return out;
  };

  const scoreOf = (f: FactRecord): number => {
    if (scoreFieldPath) {
      const raw = getPath(f, scoreFieldPath as (string | number)[]);
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    if (query.size === 0) return 0;
    let score = 0;
    for (let i = 0; i < candidateFields.length; i++) {
      const w = Number.isFinite(weights[i] as number) ? (weights[i] as number) : 1;
      const toks = tokensAt(f, candidateFields[i]);
      let overlap = 0;
      for (const q of query) if (toks.has(q)) overlap += 1;
      score += w * overlap;
    }
    return score;
  };

  const scored = facts.map((f) => ({ id: typeof f.id === "string" ? f.id : null, score: scoreOf(f) }));
  const minScore = Number.isFinite(params.minScore) ? (params.minScore as number) : null;
  const kept = scored.filter((s) => (minScore == null ? Number.isFinite(s.score) : s.score >= minScore));
  kept.sort((a, b) => b.score - a.score);
  const limited = typeof params.topK === "number" && params.topK >= 0 ? kept.slice(0, params.topK) : kept;

  const scores: Record<string, number> = {};
  for (const s of scored) if (s.id != null && Number.isFinite(s.score)) scores[s.id] = s.score;
  const top = limited[0]?.id ?? null;
  const confidence = limited.length > 0 && (limited[0]?.score ?? 0) > 0 ? 1 : 0;
  return { value: { ranked: limited, top, scores }, confidence, basis: basisOf(inputs) };
};

const mutualOverlapOp: MeasureOp = (inputs, params) => {
  const facts = inputs[0]?.facts ?? [];
  const xField = Array.isArray(params.xField) ? (params.xField as (string | number)[]) : null;
  const yField = Array.isArray(params.yField) ? (params.yField as (string | number)[]) : null;
  if (!xField || !yField) return { value: [], confidence: 0, basis: basisOf(inputs) };

  const harvest = (raw: unknown, out: Set<string>, depth: number): void => {
    if (depth > 6 || raw == null) return;
    if (typeof raw === "string") {
      for (const tok of raw.toLowerCase().split(/[^a-z0-9]+/i)) if (tok) out.add(tok);
      return;
    }
    if (Array.isArray(raw)) { for (const el of raw) harvest(el, out, depth + 1); return; }
    if (typeof raw === "object") for (const v of Object.values(raw as Record<string, unknown>)) harvest(v, out, depth + 1);
  };
  const tokensOf = (f: FactRecord, path: (string | number)[]): Set<string> => {
    const out = new Set<string>();
    harvest(getPath(f, path), out, 0);
    return out;
  };
  const intersectCount = (a: Set<string>, b: Set<string>): number => {
    let n = 0;
    for (const t of a) if (b.has(t)) n += 1;
    return n;
  };
  const combine =
    params.combine === "product" ? (a: number, b: number) => a * b :
    params.combine === "sum" ? (a: number, b: number) => a + b :
    params.combine === "mean" ? (a: number, b: number) => (a + b) / 2 :
    (a: number, b: number) => Math.min(a, b); // default: mutual = both directions

  const prepared = facts
    .filter((f) => typeof f.id === "string")
    .map((f) => ({ id: f.id as string, x: tokensOf(f, xField), y: tokensOf(f, yField) }));

  type PairRow = { id: string; a: string; b: string; forward: number; backward: number; score: number };
  const rows: PairRow[] = [];
  const minScore = Number.isFinite(params.minScore) ? (params.minScore as number) : null;
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j]; // i < j → self-pairs structurally impossible
      const forward = intersectCount(a.x, b.y);
      const backward = intersectCount(b.x, a.y);
      const score = combine(forward, backward);
      if (minScore != null && score < minScore) continue;
      rows.push({ id: `${a.id}~${b.id}`, a: a.id, b: b.id, forward, backward, score });
    }
  }
  rows.sort((p, q) => q.score - p.score);
  const limited = typeof params.topK === "number" && params.topK >= 0 ? rows.slice(0, params.topK) : rows;
  const confidence = limited.length > 0 && limited[0].score > 0 ? 1 : 0;
  return { value: limited, confidence, basis: basisOf(inputs) };
};

export const measureOps: OpMap = {
  count: countOp,
  sum: sumOp,
  distinct: distinctOp,
  ratio: ratioOp,
  bin: binOp,
  band: bandOp,
  rank: rankOp,
  latest: latestOp,
  quantile: quantileOp,
  angle: angleOp,
  rollup: rollupOp,
  formula: formulaOp,
  "reduce-graph": reduceGraphOp,
  "weighted-rank": weightedRankOp,
  "derive-spans": deriveSpansOp,
  "constrained-span-pack": constrainedSpanPackOp,
  "relevance-rank": relevanceRankOp,
  "mutual-overlap": mutualOverlapOp,
};
