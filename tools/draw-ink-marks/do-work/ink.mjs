// tools/draw-ink-marks: the ink mechanism. Marks are append-only operations on an addressed space; what is visible
// is the fold of the operations, so a mark is never edited, only hidden, restyled, reordered, copied or merged by a
// later operation that names it. Everything here is pure: data in, data out. What a space, a tool, a colour or a
// shape is called belongs to the person's own records.

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value : undefined);
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const arrayOf = value => (Array.isArray(value) ? value : []);
const objectOf = value => (isObject(value) ? value : {});
const firstText = (row, keys) => { for (const key of keys) { const value = text(row[key]); if (value) return value; } return undefined; };
const firstNumber = (row, keys) => { for (const key of keys) { const value = number(row[key]); if (value !== undefined) return value; } return undefined; };
const byOrderThenId = (left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id);

// A row may arrive bare, as { payload }, or as { value_json } text: the records door hands any of them over.
function parseRow(value) {
  if (!isObject(value)) return value;
  if ('payload' in value) return value.payload;
  if (typeof value.value_json === 'string') {
    try { return JSON.parse(value.value_json); } catch { return value.value_json; }
  }
  return value;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value.flatMap(item => rowsFrom(parseRow(item)));
  if (!isObject(value)) return [];
  for (const key of ['records', 'rows', 'operations', 'styles', 'tools']) {
    if (Array.isArray(value[key])) return rowsFrom(value[key]);
  }
  return [parseRow(value)];
}

const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};

function readAxes(raw) {
  return arrayOf(raw).map((axis, index) => {
    const row = objectOf(axis);
    const range = Array.isArray(row.range) && row.range.length >= 2 ? [Number(row.range[0]), Number(row.range[1])] : undefined;
    return {
      id: firstText(row, ['id', 'name']) ?? `axis:${index}`,
      unit: firstText(row, ['unit']),
      range: range && Number.isFinite(range[0]) && Number.isFinite(range[1]) ? range : undefined,
    };
  });
}

function readFrame(raw) {
  const row = objectOf(raw);
  const id = firstText(row, ['id', 'frame_id', 'frameId']);
  if (!id && !Array.isArray(row.axes)) return undefined;
  const extent = arrayOf(row.extent).map(Number).filter(Number.isFinite);
  return {
    id: id ?? 'frame',
    axes: readAxes(row.axes),
    ...(row.origin !== undefined ? { origin: row.origin } : {}),
    ...(row.basis !== undefined ? { basis: row.basis } : {}),
    ...(extent.length > 0 ? { extent } : {}),
  };
}

export function readMarkTarget(raw) {
  const row = objectOf(raw);
  return {
    address: firstText(row, ['address', 'address_label', 'addressLabel', 'id', 'ref']) ?? 'target',
    frame: readFrame(row.frame ?? row.coordinate_frame ?? row.coordinateFrame),
    range: row.range,
    anchor: row.anchor,
    readerKey: firstText(row, ['reader_key', 'readerKey']),
  };
}

// The identity of the space a mark is drawn on: same address, frame, range, anchor and reader key give the same key.
export function markTargetKey(target, readerKey) {
  const key = { address: target.address };
  if (target.frame) {
    const frame = {
      id: target.frame.id,
      axes: target.frame.axes.map(axis => ({
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

function readPoint(raw) {
  const row = objectOf(raw);
  const values = arrayOf(row.values).map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  return {
    values,
    at: typeof row.at === 'string' || typeof row.at === 'number' ? row.at : undefined,
    weight: number(row.weight),
    meta: isObject(row.meta) ? row.meta : undefined,
  };
}

function readCoordinateSet(raw, index) {
  const row = objectOf(raw);
  const points = arrayOf(row.points).map(readPoint).filter(Boolean);
  if (!points.length) return null;
  return {
    id: firstText(row, ['id', 'ref']) ?? `set:${index}`,
    frameRef: firstText(row, ['frame_ref', 'frameRef']),
    points,
    closed: row.closed === true,
    refs: arrayOf(row.refs).map(text).filter(Boolean),
    order: number(row.order),
  };
}

function readOperationBody(raw) {
  const row = objectOf(raw);
  const coordinateRows = row.coordinate_sets ?? row.coordinateSets ?? row.coordinate_set ?? row.coordinateSet ?? row.coordinates ?? [];
  return {
    coordinateSets: (Array.isArray(coordinateRows) ? coordinateRows : [coordinateRows]).map(readCoordinateSet).filter(Boolean),
    effects: objectOf(row.effects),
    raw: row,
  };
}

// Operations in the order they were made: sequence, then time, then id.
export function readMarkOperationRecords(raw) {
  return rowsFrom(raw)
    .map((value, index) => {
      const row = objectOf(value);
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

export function readMarkStyles(raw) {
  return rowsFrom(raw)
    .map((value, index) => {
      const row = objectOf(value);
      return {
        id: firstText(row, ['id', 'style_ref', 'styleRef']) ?? `style:${index}`,
        label: firstText(row, ['label', 'name']),
        stroke: firstText(row, ['stroke']),
        strokeToken: firstText(row, ['stroke_token', 'strokeToken']),
        strokeWidth: firstNumber(row, ['stroke_width', 'strokeWidth']),
        strokeOpacity: firstNumber(row, ['stroke_opacity', 'strokeOpacity']),
        fill: firstText(row, ['fill']),
        fillOpacity: firstNumber(row, ['fill_opacity', 'fillOpacity']),
        order: firstNumber(row, ['order']),
        raw: row,
      };
    })
    .sort(byOrderThenId);
}

export function readMarkTools(raw) {
  return rowsFrom(raw)
    .map((value, index) => {
      const row = objectOf(value);
      const body = objectOf(row.body);
      return {
        id: firstText(row, ['id', 'tool_ref', 'toolRef']) ?? `tool:${index}`,
        label: firstText(row, ['label', 'name']),
        order: firstNumber(row, ['order']),
        mapper: isObject(body.mapper) ? body.mapper : isObject(row.mapper) ? row.mapper : undefined,
        mode: firstText(body, ['mode']) ?? firstText(row, ['mode']),
        raw: row,
      };
    })
    .sort(byOrderThenId);
}

const coordinate = (point, index) => (Number.isFinite(point.values[index]) ? point.values[index] : 0);

// What one stroke becomes, chosen by the tool's own mapper row:
//   passthrough  every captured point (freehand)           segment  first and last point (straight line)
//   polygon + corners  the four corners of the rectangle between first and last point
//   polygon + sides N  N points on the ellipse inscribed in that rectangle (N of 3 to 18 reads as a regular polygon,
//                      a large N as an ellipse)
// A mapper of any other kind keeps the stroke as drawn, so a tool row from a newer version still works.
export function mapPointsForTool(tool, points) {
  if (points.length < 2) return points;
  const mapper = tool?.mapper;
  const kind = mapper ? text(mapper.kind) : undefined;
  const first = points[0];
  const last = points[points.length - 1];
  if (kind === 'segment') return [first, last];
  if (kind !== 'polygon') return points;
  const x0 = coordinate(first, 0);
  const y0 = coordinate(first, 1);
  const x1 = coordinate(last, 0);
  const y1 = coordinate(last, 1);
  if (mapper.corners === true) return [{ values: [x0, y0] }, { values: [x1, y0] }, { values: [x1, y1] }, { values: [x0, y1] }];
  const sides = number(mapper.sides);
  if (!sides || sides < 3) return points;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  return Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2 - Math.PI / 2;
    return { values: [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] };
  });
}

export const toolErases = tool => tool?.mode === 'erase';

export function toolEmitsClosedSet(tool) {
  const body = objectOf(tool?.raw?.body);
  if (objectOf(body.coordinate_set ?? body.coordinateSet).closed === true) return true;
  return tool?.mapper ? tool.mapper.closed === true : false;
}

const refsFrom = value => arrayOf(value).map(text).filter(Boolean);

function applyReferenceEffects(pathsByRef, hiddenRefs, styles, effects) {
  for (const ref of refsFrom(effects.hide_refs ?? effects.hideRefs)) hiddenRefs.add(ref);

  for (const [ref, styleRef] of Object.entries(objectOf(effects.style_ref_by_ref ?? effects.styleRefByRef))) {
    const path = pathsByRef.get(ref);
    if (path && typeof styleRef === 'string') {
      pathsByRef.set(ref, { ...path, operation: { ...path.operation, styleRef }, style: styles.get(styleRef) ?? path.style });
    }
  }

  for (const [ref, order] of Object.entries(objectOf(effects.order_by_ref ?? effects.orderByRef))) {
    const path = pathsByRef.get(ref);
    const value = number(order);
    if (path && value !== undefined) pathsByRef.set(ref, { ...path, order: value });
  }

  const copies = objectOf(effects.copy_ref_by_ref ?? effects.copyRefByRef ?? effects.split_ref_by_ref ?? effects.splitRefByRef);
  for (const [sourceRef, targets] of Object.entries(copies)) {
    const source = pathsByRef.get(sourceRef);
    if (!source) continue;
    for (const ref of refsFrom(targets)) pathsByRef.set(ref, { ...source, ref, coordinateSet: { ...source.coordinateSet, id: ref } });
  }

  for (const merge of arrayOf(effects.merge_refs ?? effects.mergeRefs)) {
    const row = objectOf(merge);
    const ref = firstText(row, ['ref', 'id']);
    const sources = refsFrom(row.refs).map(sourceRef => pathsByRef.get(sourceRef)).filter(Boolean);
    if (!ref || !sources.length) continue;
    pathsByRef.set(ref, {
      ...sources[0],
      ref,
      coordinateSet: { ...sources[0].coordinateSet, id: ref, points: sources.flatMap(path => [...path.coordinateSet.points]) },
    });
  }
}

// A mark may carry its own style fields (a per-stroke width, say) over the style it names, without touching that style.
function mergeOperationStyle(referenced, rawStyle) {
  if (!isObject(rawStyle)) return referenced;
  const local = readMarkStyles([rawStyle])[0];
  if (!local) return referenced;
  if (!referenced) return local;
  const has = (...keys) => keys.some(key => local.raw[key] !== undefined);
  return {
    ...referenced,
    strokeToken: has('stroke_token', 'strokeToken') ? local.strokeToken : referenced.strokeToken,
    stroke: has('stroke') ? local.stroke : referenced.stroke,
    strokeWidth: has('stroke_width', 'strokeWidth') ? local.strokeWidth : referenced.strokeWidth,
    strokeOpacity: has('stroke_opacity', 'strokeOpacity') ? local.strokeOpacity : referenced.strokeOpacity,
    fill: has('fill') ? local.fill : referenced.fill,
    fillOpacity: has('fill_opacity', 'fillOpacity') ? local.fillOpacity : referenced.fillOpacity,
  };
}

const isOperationRecord = value => {
  const row = objectOf(value);
  return typeof row.id === 'string' && isObject(row.target) && isObject(row.body) && Array.isArray(row.body.coordinateSets);
};

// The marks visible on one target: every operation for that target folded in order, then what later operations hid
// removed. With no target given every operation counts.
export function materializeMarkRecords({ operations: rawOperations, styles: rawStyles, target, readerKey }) {
  const operations = Array.isArray(rawOperations) && rawOperations.every(isOperationRecord) ? rawOperations : readMarkOperationRecords(rawOperations);
  const styles = new Map(readMarkStyles(rawStyles).map(style => [style.id, style]));
  const targetKey = target ? markTargetKey(target, readerKey) : '';
  const pathsByRef = new Map();
  const hiddenRefs = new Set();
  const unrendered = [];

  for (const operation of operations) {
    const operationTargetKey = markTargetKey(operation.target, readerKey);
    if (targetKey && operationTargetKey !== targetKey) continue;
    if (!operation.body.coordinateSets.length) unrendered.push(operation);
    operation.body.coordinateSets.forEach((coordinateSet, index) => {
      const ref = coordinateSet.refs?.[0] ?? `${operation.id}:set:${index}`;
      const referenced = operation.styleRef ? styles.get(operation.styleRef) ?? null : null;
      pathsByRef.set(ref, {
        ref,
        targetKey: operationTargetKey,
        coordinateSet,
        operation,
        style: mergeOperationStyle(referenced, operation.body.raw.style),
        order: coordinateSet.order ?? operation.sequence ?? index,
      });
    });
    applyReferenceEffects(pathsByRef, hiddenRefs, styles, operation.body.effects);
  }

  const paths = [...pathsByRef.values()]
    .filter(path => !hiddenRefs.has(path.ref))
    .sort((left, right) => left.order - right.order || left.ref.localeCompare(right.ref));
  return { targetKey, paths, hiddenRefs: [...hiddenRefs].sort(), operations, unrendered };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// The visible mark nearest a point, within a radius, in the target's own coordinate units. Erasing appends an
// operation whose hide_refs names the answer; the marks themselves are never changed.
export function nearestMarkPathRef(material, point, radius) {
  const px = coordinate(point, 0);
  const py = coordinate(point, 1);
  let bestRef = null;
  let bestDistance = radius;
  for (const path of material.paths) {
    const points = path.coordinateSet.points;
    points.forEach((from, index) => {
      const next = points[index + 1] ?? (path.coordinateSet.closed ? points[0] : undefined);
      const distance = next
        ? distanceToSegment(px, py, coordinate(from, 0), coordinate(from, 1), coordinate(next, 0), coordinate(next, 1))
        : Math.hypot(px - coordinate(from, 0), py - coordinate(from, 1));
      if (distance <= bestDistance) { bestDistance = distance; bestRef = path.ref; }
    });
  }
  return bestRef;
}

const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The visible marks as an SVG stroke fragment (one path each: M x y, L x y, Z when closed, round caps, the style's
// stroke, width and opacity) and the bounds of all ink, or null bounds when there is none. A style that names only
// a colour token has no colour a standalone SVG can resolve, so it takes `defaultStroke` (supplied by the caller).
export function marksToSvg(material, { defaultStroke } = {}) {
  const parts = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of material.paths) {
    const points = path.coordinateSet.points;
    if (points.length === 0) continue;
    const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${coordinate(point, 0)} ${coordinate(point, 1)}`).join(' ') + (path.coordinateSet.closed ? ' Z' : '');
    const stroke = path.style?.stroke || defaultStroke;
    if (!stroke) throw new Error(`mark ${path.ref} has no colour: give its style a stroke or pass default_stroke`);
    parts.push(
      `<path d="${escapeAttribute(d)}" fill="none" stroke="${escapeAttribute(stroke)}" `
      + `stroke-width="${path.style?.strokeWidth ?? 3}" stroke-opacity="${path.style?.strokeOpacity ?? 1}" `
      + 'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>',
    );
    for (const point of points) {
      const x = coordinate(point, 0);
      const y = coordinate(point, 1);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { svg: parts.join(''), bounds: minX === Infinity ? null : { minX, minY, maxX, maxY } };
}
