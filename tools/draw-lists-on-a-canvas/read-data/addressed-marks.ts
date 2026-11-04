export type JsonObject = Record<string, unknown>;

export interface MarkAxis {
  id: string;
  unit?: string;
  range?: readonly [number, number];
}

export interface MarkCoordinateFrame {
  id: string;
  axes: readonly MarkAxis[];
  origin?: unknown;
  basis?: unknown;
  extent?: readonly number[];
}

export interface MarkTarget {
  address: string;
  frame?: MarkCoordinateFrame;
  range?: unknown;
  anchor?: unknown;
  readerKey?: string;
}

export interface MarkCoordinatePoint {
  values: readonly number[];
  at?: number | string;
  weight?: number;
  meta?: JsonObject;
}

export interface MarkCoordinateSet {
  id: string;
  frameRef?: string;
  points: readonly MarkCoordinatePoint[];
  closed?: boolean;
  refs?: readonly string[];
  order?: number;
}

export interface MarkOperationBody {
  coordinateSets: readonly MarkCoordinateSet[];
  effects: JsonObject;
  raw: JsonObject;
}

export interface MarkOperationRecord {
  id: string;
  target: MarkTarget;
  toolRef?: string;
  styleRef?: string;
  createdAt?: string;
  sequence?: number;
  body: MarkOperationBody;
  raw: JsonObject;
}

export interface MarkStyleRecord {
  id: string;
  label?: string;
  strokeToken?: string;
  stroke?: string;
  /** Stroke width in reader screen pixels (strokes render with non-scaling-stroke). */
  strokeWidth?: number;
  strokeOpacity?: number;
  /**
   * Fill decoration: a visual layer stack (same as regions use). The mark's SVG
   * path provides stroke + clip geometry; the stack renders via the capability
   * registry, clipped by the path's shape. Reuse region fills: solid, gradient,
   * mesh, image, video, grain, tint — all work blind.
   *
   * Type: `VisualLayerStackRecord` (imported from ui; stored as unknown to avoid
   * circular import; validated at runtime via isVisualLayerStackRecord).
   *
   * Back-compat: solid `fill`/`fillOpacity` fields are converted to a single
   * solid-capability layer at read time (see readMarkStyles).
   */
  decoration?: unknown;
  /**
   * Legacy: solid color fill (string like "#ff0000"). Deprecated in favor of
   * `decoration`. Present for back-compat; new styles use decoration only.
   */
  fill?: string;
  /**
   * Legacy: fill opacity (0..1). Deprecated in favor of decoration. Present for
   * back-compat; new styles use decoration only.
   */
  fillOpacity?: number;
  order?: number;
  raw: JsonObject;
}

export interface MarkToolRecord {
  id: string;
  label?: string;
  icon?: string;
  order?: number;
  /** Data-selected pointer→coordinate-set mapper. Unknown kinds fall back to passthrough. */
  mapper?: JsonObject;
  /** Optional tool mode. "erase" appends hide_refs operations instead of ink. */
  mode?: string;
  raw: JsonObject;
}

export interface MarkMaterialPath {
  ref: string;
  targetKey: string;
  coordinateSet: MarkCoordinateSet;
  operation: MarkOperationRecord;
  style: MarkStyleRecord | null;
  order: number;
}

export interface MarkMaterial {
  targetKey: string;
  paths: readonly MarkMaterialPath[];
  hiddenRefs: readonly string[];
  operations: readonly MarkOperationRecord[];
  unrendered: readonly MarkOperationRecord[];
}

export interface MarkMaterialOptions {
  operations: unknown;
  styles?: unknown;
  target?: MarkTarget;
  readerKey?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstText(record: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(record: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = number(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseRow(value: unknown): unknown {
  if (!isObject(value)) return value;
  if ('payload' in value) return value.payload;
  if ('value_json' in value && typeof value.value_json === 'string') {
    try {
      return JSON.parse(value.value_json) as unknown;
    } catch {
      return value.value_json;
    }
  }
  return value;
}

function rowsFrom(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => rowsFrom(parseRow(item)));
  if (!isObject(value)) return [];
  for (const key of ['records', 'rows', 'operations', 'styles', 'tools']) {
    if (Array.isArray(value[key])) return rowsFrom(value[key]);
  }
  return [parseRow(value)];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function readAxes(raw: unknown): readonly MarkAxis[] {
  return arrayValue(raw).map((axis, index) => {
    const row = objectValue(axis);
    const range = Array.isArray(row.range) && row.range.length >= 2
      ? [Number(row.range[0]), Number(row.range[1])] as const
      : undefined;
    return {
      id: firstText(row, ['id', 'name']) ?? `axis:${index}`,
      unit: firstText(row, ['unit']),
      range: range && Number.isFinite(range[0]) && Number.isFinite(range[1]) ? range : undefined,
    };
  });
}

function readFrame(raw: unknown): MarkCoordinateFrame | undefined {
  const row = objectValue(raw);
  const id = firstText(row, ['id', 'frame_id', 'frameId']);
  if (!id && !Array.isArray(row.axes)) return undefined;
  const extent = arrayValue(row.extent).map(Number).filter(Number.isFinite);
  return {
    id: id ?? 'frame',
    axes: readAxes(row.axes),
    ...(row.origin !== undefined ? { origin: row.origin } : {}),
    ...(row.basis !== undefined ? { basis: row.basis } : {}),
    ...(extent.length > 0 ? { extent } : {}),
  };
}

export function readMarkTarget(raw: unknown): MarkTarget {
  const row = objectValue(raw);
  const address = firstText(row, ['address', 'address_label', 'addressLabel', 'id', 'ref']) ?? 'target';
  return {
    address,
    frame: readFrame(row.frame ?? row.coordinate_frame ?? row.coordinateFrame),
    range: row.range,
    anchor: row.anchor,
    readerKey: firstText(row, ['reader_key', 'readerKey']),
  };
}

export function markTargetKey(target: MarkTarget, readerKey?: string): string {
  const key: JsonObject = { address: target.address };
  if (target.frame) {
    const frame: JsonObject = {
      id: target.frame.id,
      axes: target.frame.axes.map((axis) => ({
        id: axis.id,
        ...(axis.unit !== undefined ? { unit: axis.unit } : {}),
        ...(axis.range !== undefined ? { range: axis.range } : {}),
      })),
    };
    if (target.frame.origin !== undefined) frame.origin = target.frame.origin;
    if (target.frame.basis !== undefined) frame.basis = target.frame.basis;
    if (target.frame.extent && target.frame.extent.length > 0) frame.extent = target.frame.extent;
    key.frame = frame;
  }
  if (target.range !== undefined) key.range = target.range;
  if (target.anchor !== undefined) key.anchor = target.anchor;
  const resolvedReaderKey = readerKey ?? target.readerKey;
  if (resolvedReaderKey !== undefined) key.readerKey = resolvedReaderKey;
  return stableJson(key);
}

function readPoint(raw: unknown): MarkCoordinatePoint | null {
  const row = objectValue(raw);
  const values = arrayValue(row.values).map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  return {
    values,
    at: typeof row.at === 'string' || typeof row.at === 'number' ? row.at : undefined,
    weight: number(row.weight),
    meta: isObject(row.meta) ? row.meta : undefined,
  };
}

function readCoordinateSet(raw: unknown, index: number): MarkCoordinateSet | null {
  const row = objectValue(raw);
  const points = arrayValue(row.points).map(readPoint).filter((point): point is MarkCoordinatePoint => Boolean(point));
  if (!points.length) return null;
  return {
    id: firstText(row, ['id', 'ref']) ?? `set:${index}`,
    frameRef: firstText(row, ['frame_ref', 'frameRef']),
    points,
    closed: row.closed === true,
    refs: arrayValue(row.refs).map((ref) => text(ref)).filter((ref): ref is string => Boolean(ref)),
    order: number(row.order),
  };
}

function readOperationBody(raw: unknown): MarkOperationBody {
  const row = objectValue(raw);
  const coordinateRows =
    row.coordinate_sets ??
    row.coordinateSets ??
    row.coordinate_set ??
    row.coordinateSet ??
    row.coordinates ??
    [];
  const coordinateRowList = Array.isArray(coordinateRows) ? coordinateRows : [coordinateRows];
  return {
    coordinateSets: coordinateRowList
      .map(readCoordinateSet)
      .filter((set): set is MarkCoordinateSet => Boolean(set)),
    effects: objectValue(row.effects),
    raw: row,
  };
}

export function readMarkOperationRecords(raw: unknown): readonly MarkOperationRecord[] {
  return rowsFrom(raw)
    .map((value, index): MarkOperationRecord => {
      const row = objectValue(value);
      return {
        id: firstText(row, ['id', 'operation_id', 'operationId']) ?? `operation:${index}`,
        target: readMarkTarget(row.target),
        toolRef: firstText(row, ['tool_ref', 'toolRef']),
        styleRef: firstText(row, ['style_ref', 'styleRef']),
        createdAt: firstText(row, ['created_at', 'createdAt']),
        sequence: firstNumber(row, ['sequence', 'order']),
        body: readOperationBody(row.body ?? row),
        raw: row,
      };
    })
    .sort((left, right) => (
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
      || (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
      || left.id.localeCompare(right.id)
    ));
}

function isMarkOperationRecord(value: unknown): value is MarkOperationRecord {
  const row = objectValue(value);
  return (
    typeof row.id === 'string'
    && isObject(row.target)
    && isObject(row.body)
    && Array.isArray(row.body.coordinateSets)
  );
}

function operationRecordsFrom(raw: unknown): readonly MarkOperationRecord[] {
  if (Array.isArray(raw) && raw.every(isMarkOperationRecord)) {
    return raw;
  }
  return readMarkOperationRecords(raw);
}

/**
 * Convert a style record's decoration field (VisualLayerStackRecord) or legacy
 * fill fields into the mark's visual-layer-stack structure. Back-compat: solid
 * `fill`/`fillOpacity` are converted to a single solid-capability layer.
 *
 * Type: VisualLayerStackRecord is NOT imported here (circular import risk).
 * The record is validated at render time via isVisualLayerStackRecord.
 */
function readMarkDecoration(row: JsonObject): unknown {
  // New explicit decoration field: already a VisualLayerStackRecord, pass through
  if (row.decoration && typeof row.decoration === 'object' && !Array.isArray(row.decoration)) {
    const dec = row.decoration as Record<string, unknown>;
    // Validate shape: { kind: 'visual-layer-stack', version: 1, region, layers: [...] }
    if (dec.kind === 'visual-layer-stack' && dec.version === 1 && Array.isArray(dec.layers)) {
      return dec; // Valid VisualLayerStackRecord; pass through as-is
    }
  }

  // Back-compat: legacy solid fill + fillOpacity → single solid-capability layer
  const fill = firstText(row, ['fill']);
  if (fill) {
    const opacity = firstNumber(row, ['fill_opacity', 'fillOpacity']);
    // Build a minimal VisualLayerStackRecord with a single solid-capability layer
    // The region address is placeholder; render time will inject the correct region.
    return {
      kind: 'visual-layer-stack',
      version: 1,
      region: { family: 'mark-fill', parts: {} },
      layers: [
        {
          id: 'fill:solid',
          paint: {
            capability: {
              registry: { family: 'ui.visual-layer-stack.capabilities', parts: { pack: 'builtin' } },
              capabilityId: 'solid',
            },
            input: {
              color: fill,
            },
          },
          ...(opacity !== undefined ? { composite: { opacity } } : {}),
        },
      ],
    };
  }

  return undefined;
}

export function readMarkStyles(raw: unknown): readonly MarkStyleRecord[] {
  return rowsFrom(raw)
    .map((value, index): MarkStyleRecord => {
      const row = objectValue(value);
      return {
        id: firstText(row, ['id', 'style_ref', 'styleRef']) ?? `style:${index}`,
        label: firstText(row, ['label', 'name']),
        strokeToken: firstText(row, ['stroke_token', 'strokeToken']),
        stroke: firstText(row, ['stroke']),
        strokeWidth: firstNumber(row, ['stroke_width', 'strokeWidth']),
        strokeOpacity: firstNumber(row, ['stroke_opacity', 'strokeOpacity']),
        decoration: readMarkDecoration(row),
        // Keep legacy fields for backward compatibility (may be used in raw)
        fill: firstText(row, ['fill']),
        fillOpacity: firstNumber(row, ['fill_opacity', 'fillOpacity']),
        order: firstNumber(row, ['order']),
        raw: row,
      };
    })
    .sort((left, right) => (
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
    ));
}

export function readMarkTools(raw: unknown): readonly MarkToolRecord[] {
  return rowsFrom(raw)
    .map((value, index): MarkToolRecord => {
      const row = objectValue(value);
      const body = objectValue(row.body);
      const mapper = isObject(body.mapper) ? body.mapper : isObject(row.mapper) ? row.mapper : undefined;
      return {
        id: firstText(row, ['id', 'tool_ref', 'toolRef']) ?? `tool:${index}`,
        label: firstText(row, ['label', 'name']),
        icon: firstText(row, ['icon']),
        order: firstNumber(row, ['order']),
        mapper,
        mode: firstText(body, ['mode']) ?? firstText(row, ['mode']),
        raw: row,
      };
    })
    .sort((left, right) => (
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
    ));
}

/**
 * Map raw pointer points into the coordinate-set points a tool emits.
 *
 * Mappers are pure geometry physics selected by tool DATA:
 * - passthrough: every captured point (freehand ink)
 * - segment: first and last point (straight line)
 * - polygon + corners: axis-aligned corner loop between first and last point
 * - polygon + sides(N) + inscribed: N points sampled on the ellipse inscribed
 *   in the rect spanned by first and last point (N=48 reads as an ellipse,
 *   N=3..18 reads as a regular polygon — an 18-gon is data, not code)
 * - unknown kind: passthrough (unknown tool bytes must keep working)
 */
export function mapPointsForTool(
  tool: MarkToolRecord | null | undefined,
  points: readonly MarkCoordinatePoint[],
): readonly MarkCoordinatePoint[] {
  if (points.length < 2) return points;
  const mapper = tool?.mapper;
  const kind = mapper ? text(mapper.kind) : undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (kind === 'segment') return [first, last];
  if (kind === 'polygon') {
    const x0 = coordinate(first, 0);
    const y0 = coordinate(first, 1);
    const x1 = coordinate(last, 0);
    const y1 = coordinate(last, 1);
    if (mapper && mapper.corners === true) {
      return [
        { values: [x0, y0] },
        { values: [x1, y0] },
        { values: [x1, y1] },
        { values: [x0, y1] },
      ];
    }
    const sides = mapper ? number(mapper.sides) : undefined;
    if (sides && sides >= 3) {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2;
      const ry = Math.abs(y1 - y0) / 2;
      const sampled: MarkCoordinatePoint[] = [];
      for (let index = 0; index < sides; index += 1) {
        const angle = (index / sides) * Math.PI * 2 - Math.PI / 2;
        sampled.push({ values: [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] });
      }
      return sampled;
    }
  }
  return points;
}

function coordinate(point: MarkCoordinatePoint, index: number): number {
  const value = point.values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** True when the tool appends reference-effect hide operations instead of ink. */
export function toolErases(tool: MarkToolRecord | null | undefined): boolean {
  return tool?.mode === 'erase';
}

/** Whether the tool's emitted coordinate set is closed (loop back to start). */
export function toolEmitsClosedSet(tool: MarkToolRecord | null | undefined): boolean {
  const body = tool ? objectValue(tool.raw.body) : {};
  const coordinateSet = objectValue(body.coordinate_set ?? body.coordinateSet);
  if (coordinateSet.closed === true) return true;
  const mapper = tool?.mapper;
  return mapper ? mapper.closed === true : false;
}

function refsFrom(value: unknown): readonly string[] {
  return arrayValue(value).map((ref) => text(ref)).filter((ref): ref is string => Boolean(ref));
}

function applyReferenceEffects(
  pathsByRef: Map<string, MarkMaterialPath>,
  hiddenRefs: Set<string>,
  styles: ReadonlyMap<string, MarkStyleRecord>,
  effects: JsonObject,
): void {
  for (const ref of refsFrom(effects.hide_refs ?? effects.hideRefs)) hiddenRefs.add(ref);

  const styleByRef = objectValue(effects.style_ref_by_ref ?? effects.styleRefByRef);
  for (const [ref, styleRef] of Object.entries(styleByRef)) {
    const path = pathsByRef.get(ref);
    if (path && typeof styleRef === 'string') {
      pathsByRef.set(ref, {
        ...path,
        operation: { ...path.operation, styleRef },
        style: styles.get(styleRef) ?? path.style,
      });
    }
  }

  const orderByRef = objectValue(effects.order_by_ref ?? effects.orderByRef);
  for (const [ref, order] of Object.entries(orderByRef)) {
    const path = pathsByRef.get(ref);
    const value = number(order);
    if (path && value !== undefined) pathsByRef.set(ref, { ...path, order: value });
  }

  const copyByRef = objectValue(effects.copy_ref_by_ref ?? effects.copyRefByRef ?? effects.split_ref_by_ref ?? effects.splitRefByRef);
  for (const [sourceRef, targets] of Object.entries(copyByRef)) {
    const source = pathsByRef.get(sourceRef);
    if (!source) continue;
    for (const ref of refsFrom(targets)) {
      pathsByRef.set(ref, {
        ...source,
        ref,
        coordinateSet: { ...source.coordinateSet, id: ref },
      });
    }
  }

  for (const merge of arrayValue(effects.merge_refs ?? effects.mergeRefs)) {
    const row = objectValue(merge);
    const ref = firstText(row, ['ref', 'id']);
    const refs = refsFrom(row.refs);
    if (!ref || !refs.length) continue;
    const sources = refs.map((sourceRef) => pathsByRef.get(sourceRef)).filter((path): path is MarkMaterialPath => Boolean(path));
    if (!sources.length) continue;
    pathsByRef.set(ref, {
      ...sources[0],
      ref,
      coordinateSet: {
        ...sources[0].coordinateSet,
        id: ref,
        points: sources.flatMap((path) => [...path.coordinateSet.points]),
      },
    });
  }
}

/**
 * Merge operation-local style data (operation.body.style) over the referenced
 * style record. Append-only friendly: the operation carries its own style
 * snapshot fields (e.g. a per-stroke width) without mutating any style record.
 */
function mergeOperationStyle(
  referenced: MarkStyleRecord | null,
  rawStyle: unknown,
): MarkStyleRecord | null {
  if (!isObject(rawStyle)) return referenced;
  const local = readMarkStyles([rawStyle])[0];
  if (!local) return referenced;
  if (!referenced) return local;
  return {
    ...referenced,
    strokeToken: local.raw.stroke_token !== undefined || local.raw.strokeToken !== undefined ? local.strokeToken : referenced.strokeToken,
    stroke: local.raw.stroke !== undefined ? local.stroke : referenced.stroke,
    strokeWidth: local.raw.stroke_width !== undefined || local.raw.strokeWidth !== undefined ? local.strokeWidth : referenced.strokeWidth,
    strokeOpacity: local.raw.stroke_opacity !== undefined || local.raw.strokeOpacity !== undefined ? local.strokeOpacity : referenced.strokeOpacity,
    fill: local.raw.fill !== undefined ? local.fill : referenced.fill,
    fillOpacity: local.raw.fill_opacity !== undefined || local.raw.fillOpacity !== undefined ? local.fillOpacity : referenced.fillOpacity,
  };
}

/**
 * Find the visible material path nearest to a point in the SAME coordinate
 * space as the material's target, within radius (coordinate units). Pure
 * geometry for erase-by-reference: the returned ref is hidden by appending an
 * operation with effects.hide_refs — target material is never mutated.
 */
export function nearestMarkPathRef(
  material: MarkMaterial,
  point: MarkCoordinatePoint,
  radius: number,
): string | null {
  const px = coordinate(point, 0);
  const py = coordinate(point, 1);
  let bestRef: string | null = null;
  let bestDistance = radius;
  for (const path of material.paths) {
    const points = path.coordinateSet.points;
    for (let index = 0; index < points.length; index += 1) {
      const ax = coordinate(points[index]!, 0);
      const ay = coordinate(points[index]!, 1);
      const next = points[index + 1] ?? (path.coordinateSet.closed ? points[0] : undefined);
      const distance = next
        ? distanceToSegment(px, py, ax, ay, coordinate(next, 0), coordinate(next, 1))
        : Math.hypot(px - ax, py - ay);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestRef = path.ref;
      }
    }
  }
  return bestRef;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function materializeMarkRecords(options: MarkMaterialOptions): MarkMaterial {
  const operations = operationRecordsFrom(options.operations);
  const styles = new Map(readMarkStyles(options.styles).map((style) => [style.id, style]));
  const targetKey = options.target ? markTargetKey(options.target, options.readerKey) : '';
  const pathsByRef = new Map<string, MarkMaterialPath>();
  const hiddenRefs = new Set<string>();
  const unrendered: MarkOperationRecord[] = [];

  for (const operation of operations) {
    const operationTargetKey = markTargetKey(operation.target, options.readerKey);
    if (targetKey && operationTargetKey !== targetKey) continue;
    if (!operation.body.coordinateSets.length) unrendered.push(operation);
    operation.body.coordinateSets.forEach((coordinateSet, index) => {
      const ref = coordinateSet.refs?.[0] ?? `${operation.id}:set:${index}`;
      const referenced = operation.styleRef ? styles.get(operation.styleRef) ?? null : null;
      const style = mergeOperationStyle(referenced, operation.body.raw.style);
      pathsByRef.set(ref, {
        ref,
        targetKey: operationTargetKey,
        coordinateSet,
        operation,
        style,
        order: coordinateSet.order ?? operation.sequence ?? index,
      });
    });
    applyReferenceEffects(pathsByRef, hiddenRefs, styles, operation.body.effects);
  }

  const paths = [...pathsByRef.values()]
    .filter((path) => !hiddenRefs.has(path.ref))
    .sort((left, right) => left.order - right.order || left.ref.localeCompare(right.ref));

  return {
    targetKey,
    paths,
    hiddenRefs: [...hiddenRefs].sort(),
    operations,
    unrendered,
  };
}
