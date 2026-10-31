// tools/draw-ink-marks/do-work/marks.mjs
//
// The command of the four ink tools. The verb is the first argument and one JSON request is on standard input:
//   see     { operations, styles?, target?, reader_key? }              -> { marks, hidden_refs, empty_operations }
//   stroke  { tool, points }                                           -> { points, closed, erases }
//   erase   { operations, styles?, target, point, radius, reader_key? } -> { ref, effects }
//   svg     { operations, styles?, target?, reader_key?, default_stroke? } -> { svg, bounds }
// and one JSON line out: { result }, or { error } with a non-zero exit when the request cannot be read. Operations,
// styles and tool rows are the person's own records, passed in whole (bare, as { payload } or as { value_json }).
import { text as readStdin } from 'node:stream/consumers';
import {
  mapPointsForTool, marksToSvg, materializeMarkRecords, nearestMarkPathRef,
  readMarkTarget, readMarkTools, toolEmitsClosedSet, toolErases,
} from './ink.mjs';

const toPoint = (value, name) => {
  const values = Array.isArray(value) ? value : value?.values;
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) {
    throw new Error(`${name} must be a point: [x, y] or { values: [x, y] }.`);
  }
  return { values };
};

const needTarget = input => {
  if (typeof input.target !== 'object' || input.target === null) throw new Error('target must be the space the marks are on: an object with an address.');
  return readMarkTarget(input.target);
};

const materialOf = input => {
  if (!Array.isArray(input.operations)) throw new Error('operations must be the list of mark operations.');
  return materializeMarkRecords({
    operations: input.operations,
    styles: input.styles ?? [],
    target: input.target === undefined ? undefined : readMarkTarget(input.target),
    readerKey: input.reader_key,
  });
};

const verbs = {
  see(input) {
    const material = materialOf(input);
    return {
      marks: material.paths.map(path => ({
        ref: path.ref,
        operation: path.operation.id,
        points: path.coordinateSet.points.map(point => point.values),
        closed: path.coordinateSet.closed,
        order: path.order,
        style: path.style && {
          stroke: path.style.stroke, stroke_token: path.style.strokeToken, stroke_width: path.style.strokeWidth,
          stroke_opacity: path.style.strokeOpacity, fill: path.style.fill, fill_opacity: path.style.fillOpacity,
        },
      })),
      hidden_refs: material.hiddenRefs,
      empty_operations: material.unrendered.map(operation => operation.id),
    };
  },
  stroke(input) {
    if (typeof input.tool !== 'object' || input.tool === null) throw new Error('tool must be the tool row the stroke was drawn with.');
    if (!Array.isArray(input.points) || input.points.length === 0) throw new Error('points must be the points of the stroke, in order.');
    const tool = readMarkTools([input.tool])[0];
    const points = input.points.map((point, index) => toPoint(point, `points[${index}]`));
    return { points: mapPointsForTool(tool, points).map(point => point.values), closed: toolEmitsClosedSet(tool), erases: toolErases(tool) };
  },
  erase(input) {
    needTarget(input);
    if (!Number.isFinite(input.radius) || input.radius < 0) throw new Error('radius must be a distance of zero or more, in the space\'s own units.');
    const ref = nearestMarkPathRef(materialOf(input), toPoint(input.point, 'point'), input.radius);
    return { ref, effects: ref === null ? null : { hide_refs: [ref] } };
  },
  svg(input) {
    return marksToSvg(materialOf(input), { defaultStroke: input.default_stroke });
  },
};

export const runVerb = (verb, input) => {
  if (!Object.hasOwn(verbs, verb)) throw new Error(`unknown ink command ${verb}: use see, stroke, erase or svg.`);
  return verbs[verb](input ?? {});
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: runVerb(process.argv[2], JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
