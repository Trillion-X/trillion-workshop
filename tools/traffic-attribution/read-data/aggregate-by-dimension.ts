// tools/traffic-attribution/read-data/aggregate-by-dimension.ts
//
// Entity-grouped fact aggregation. Group entities (e.g. observers) by a
// DATA-selected dimension derived from each entity's own facts, then compute
// DATA-selected metrics over each group. Traffic/UTM attribution and segment
// analytics are configurations of this. Distinct from scoreboard.ts
// `aggregateOutcomes` (which sums fact values by a path segment).
//
// A new dimension or metric is a DATA descriptor, zero code change. The metric op
// set is a closed algebra over Physics (count / sum / ratio), never a Society
// vocabulary. No source/medium/campaign/conversion literal lives here.
//
// Facts carry their full address segments, so the entity id and within-entity path
// are both available (observer fact `observer::<id>::a::b` -> ["observer","<id>","a","b"]).
// Pure: no React, no I/O, no clock.

/** One fact with its full address segments and raw value. */
export interface AddressedFact {
  address: string[];
  value: unknown;
}

/**
 * entitySegmentIndex — address index identifying the entity (1 = observer_id).
 * dimensionPath      — within-entity path whose value is the group key (first
 *                      non-empty per entity wins; within path = address.slice(idx+1)).
 * unattributedKey    — group key for entities with no dimension value.
 */
export interface EntityDimension {
  entitySegmentIndex: number;
  dimensionPath: string[];
  unattributedKey?: string;
}

/**
 * countEntities      — distinct entities in the group.
 * countEntitiesWhere — entities with >=1 fact at `path` (optional value === equals).
 * sumOverEntities    — sum of each entity's (last) value at `path`.
 * ratio              — numerator metric / denominator metric (0 when den=0).
 */
export type GroupMetric =
  | { id: string; op: 'countEntities' }
  | { id: string; op: 'countEntitiesWhere'; path: string[]; equals?: unknown }
  | { id: string; op: 'sumOverEntities'; path: string[] }
  | { id: string; op: 'ratio'; numerator: string; denominator: string };

export interface AggregateByDimensionConfig {
  dimension: EntityDimension;
  metrics: GroupMetric[];
  dimensionId?: string;
}

export interface DimensionGroup {
  dimensionKey: string;
  metrics: Record<string, number>;
}

export interface DimensionAggregation {
  dimensionId: string;
  groups: DimensionGroup[];
  totalEntities: number;
}

const DEFAULT_UNATTRIBUTED = '(unattributed)';

function pathEndsWith(address: string[], entityIndex: number, path: string[]): boolean {
  const within = address.slice(entityIndex + 1);
  if (within.length !== path.length) return false;
  for (let i = 0; i < path.length; i += 1) {
    if (within[i] !== path[i]) return false;
  }
  return true;
}

/**
 * Group entities by a dimension derived from their facts, then compute metrics.
 * O(facts) + O(entities). Pure.
 */
export function aggregateByDimension(
  facts: AddressedFact[],
  config: AggregateByDimensionConfig,
): DimensionAggregation {
  const { dimension, metrics } = config;
  const entityIndex = dimension.entitySegmentIndex;
  const unattributed = dimension.unattributedKey ?? DEFAULT_UNATTRIBUTED;

  const factsByEntity = new Map<string, AddressedFact[]>();
  for (const fact of facts) {
    if (!Array.isArray(fact.address) || fact.address.length <= entityIndex) continue;
    const entityId = fact.address[entityIndex];
    if (typeof entityId !== 'string' || entityId.length === 0) continue;
    const bucket = factsByEntity.get(entityId) ?? [];
    bucket.push(fact);
    factsByEntity.set(entityId, bucket);
  }

  const entityDimension = new Map<string, string>();
  for (const [entityId, entityFacts] of factsByEntity) {
    let key = unattributed;
    for (const fact of entityFacts) {
      if (pathEndsWith(fact.address, entityIndex, dimension.dimensionPath)) {
        const v = fact.value;
        if (v !== null && v !== undefined && String(v).trim().length > 0) {
          key = String(v).trim();
          break;
        }
      }
    }
    entityDimension.set(entityId, key);
  }

  interface GroupAcc {
    entities: Set<string>;
    whereEntities: Map<string, Set<string>>;
    sumByEntity: Map<string, Map<string, number>>;
  }
  const groups = new Map<string, GroupAcc>();
  const ensure = (key: string): GroupAcc => {
    let g = groups.get(key);
    if (!g) {
      g = { entities: new Set(), whereEntities: new Map(), sumByEntity: new Map() };
      groups.set(key, g);
    }
    return g;
  };

  for (const [entityId, entityFacts] of factsByEntity) {
    const key = entityDimension.get(entityId) ?? unattributed;
    const g = ensure(key);
    g.entities.add(entityId);

    for (const metric of metrics) {
      if (metric.op === 'countEntitiesWhere') {
        for (const fact of entityFacts) {
          if (pathEndsWith(fact.address, entityIndex, metric.path)) {
            if (metric.equals === undefined || fact.value === metric.equals) {
              let set = g.whereEntities.get(metric.id);
              if (!set) { set = new Set(); g.whereEntities.set(metric.id, set); }
              set.add(entityId);
              break;
            }
          }
        }
      } else if (metric.op === 'sumOverEntities') {
        let last: number | undefined;
        for (const fact of entityFacts) {
          if (pathEndsWith(fact.address, entityIndex, metric.path) && typeof fact.value === 'number') {
            last = fact.value;
          }
        }
        if (last !== undefined) {
          let perEntity = g.sumByEntity.get(metric.id);
          if (!perEntity) { perEntity = new Map(); g.sumByEntity.set(metric.id, perEntity); }
          perEntity.set(entityId, last);
        }
      }
    }
  }

  const outGroups: DimensionGroup[] = [];
  for (const [dimensionKey, g] of groups) {
    const m: Record<string, number> = {};
    for (const metric of metrics) {
      if (metric.op === 'countEntities') {
        m[metric.id] = g.entities.size;
      } else if (metric.op === 'countEntitiesWhere') {
        m[metric.id] = g.whereEntities.get(metric.id)?.size ?? 0;
      } else if (metric.op === 'sumOverEntities') {
        let sum = 0;
        for (const v of (g.sumByEntity.get(metric.id)?.values() ?? [])) sum += v;
        m[metric.id] = sum;
      }
    }
    for (const metric of metrics) {
      if (metric.op === 'ratio') {
        const den = m[metric.denominator];
        const num = m[metric.numerator];
        m[metric.id] = typeof den === 'number' && den !== 0 && typeof num === 'number' ? num / den : 0;
      }
    }
    outGroups.push({ dimensionKey, metrics: m });
  }

  const primary = metrics.find(
    (x) => x.op === 'countEntities' || x.op === 'countEntitiesWhere' || x.op === 'sumOverEntities',
  )?.id;
  outGroups.sort((a, b) => {
    if (primary) {
      const d = (b.metrics[primary] ?? 0) - (a.metrics[primary] ?? 0);
      if (d !== 0) return d;
    }
    return a.dimensionKey < b.dimensionKey ? -1 : a.dimensionKey > b.dimensionKey ? 1 : 0;
  });

  return {
    dimensionId: config.dimensionId ?? dimension.dimensionPath.join('.'),
    groups: outGroups,
    totalEntities: factsByEntity.size,
  };
}
