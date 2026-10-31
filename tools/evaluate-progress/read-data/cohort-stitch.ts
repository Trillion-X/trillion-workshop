// tools/evaluate-progress/read-data/cohort-stitch.ts
// Link facts that share a key value into one person, give each person the highest stage any of their facts reaches (no stage and no rank when no rule matched and the config gives no baseStage), and list the people. Key paths, strong key paths, stage rules and the confidence words are all in the config.


import { getPath } from './get-path.ts';

type Path = ReadonlyArray<string>;

export interface StageRule {
  when: { field: Path; exists?: boolean; equals?: unknown; gt?: number };
  stage: string;
  rank: number;
}

export interface CohortStitchConfig {
  keyPaths: Path[];
  strongKeyPaths: Path[];
  stageRules: StageRule[];
  sourcePath: Path;
  timePath: Path;
  valuePath?: Path;
  confidence: { identified: string; anonymous: string };
  baseStage?: { stage: string; rank: number };
}

export interface LedgerRow {
  personId: string;
  source: string | null;
  stage: string | null;
  stageRank: number | null;
  confidence: string;
  value: number;
  keyCount: number;
  factCount: number;
}

function keyValue(fact: unknown, path: Path): string | undefined {
  const v = getPath(fact, path);
  if (v == null) return undefined;
  if (typeof v === "object") return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

class DSU {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb; }
}

function factMatchesStage(fact: unknown, rule: StageRule): boolean {
  const raw = getPath(fact, rule.when.field);
  if (rule.when.exists !== undefined) {
    const present = raw !== undefined && raw !== null && !(typeof raw === "string" && raw.trim() === "");
    return rule.when.exists ? present : !present;
  }
  if (rule.when.equals !== undefined) return JSON.stringify(raw) === JSON.stringify(rule.when.equals);
  if (rule.when.gt !== undefined) { const n = typeof raw === "number" ? raw : Number(raw); return Number.isFinite(n) && n > rule.when.gt; }
  return false;
}

export function stitchCohortLedger(
  facts: ReadonlyArray<unknown>,
  config: CohortStitchConfig,
): { ledger: LedgerRow[] } {
  const n = facts.length;
  const dsu = new DSU(n);

  const valueToFirstFact = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    for (const p of config.keyPaths) {
      const v = keyValue(facts[i], p);
      if (v === undefined) continue;
      const tag = `${p.join(".")}=${v}`;         // scope the value by its path so a "3" email never links a "3" id
      const first = valueToFirstFact.get(tag);
      if (first === undefined) valueToFirstFact.set(tag, i);
      else dsu.union(first, i);
    }
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = dsu.find(i);
    (members.get(r) ?? members.set(r, []).get(r)!).push(i);
  }

  const strongSet = new Set(config.strongKeyPaths.map((p) => p.join(".")));
  const base = config.baseStage ?? null;

  const ledger: LedgerRow[] = [];
  for (const idxs of members.values()) {
    const componentFacts = idxs.map((i) => facts[i]);

    let stage: string | null = base?.stage ?? null, stageRank: number | null = base?.rank ?? null;
    for (const f of componentFacts) {
      for (const rule of config.stageRules) {
        if (factMatchesStage(f, rule) && (stageRank === null || rule.rank > stageRank)) { stage = rule.stage; stageRank = rule.rank; }
      }
    }

    let identified = false;
    const allKeys = new Set<string>();
    let strongKeyId: string | undefined;
    for (const f of componentFacts) {
      for (const p of config.keyPaths) {
        const v = keyValue(f, p);
        if (v === undefined) continue;
        const tag = p.join(".");
        allKeys.add(`${tag}=${v}`);
        if (strongSet.has(tag)) { identified = true; if (strongKeyId === undefined) strongKeyId = v; }
      }
    }
    const confidence = identified ? config.confidence.identified : config.confidence.anonymous;

    const ordered = [...componentFacts].sort((a, b) => {
      const ta = getPath(a, config.timePath), tb = getPath(b, config.timePath);
      return String(ta ?? "").localeCompare(String(tb ?? ""));
    });
    let source: string | null = null;
    for (const f of ordered) { const s = keyValue(f, config.sourcePath); if (s !== undefined) { source = s; break; } }

    let value = 0;
    if (config.valuePath) for (const f of componentFacts) { const raw = getPath(f, config.valuePath); const num = typeof raw === "number" ? raw : Number(raw); if (Number.isFinite(num)) value += num; }

    const anonKey = (() => { for (const f of ordered) for (const p of config.keyPaths) { const v = keyValue(f, p); if (v !== undefined) return v; } return undefined; })();
    const personId = strongKeyId ?? anonKey ?? `component-${idxs[0]}`;

    ledger.push({ personId, source, stage, stageRank, confidence, value, keyCount: allKeys.size, factCount: idxs.length });
  }

  ledger.sort((a, b) => ((b.stageRank ?? -Infinity) === (a.stageRank ?? -Infinity) ? 0 : (b.stageRank ?? -Infinity) > (a.stageRank ?? -Infinity) ? 1 : -1) || (b.value - a.value) || a.personId.localeCompare(b.personId));
  return { ledger };
}
