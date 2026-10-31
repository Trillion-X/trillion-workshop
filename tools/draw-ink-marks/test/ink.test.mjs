// tools/draw-ink-marks: the ink mechanism over made-up pictures. The first group carries the package's own export tests
// (stroke, width and opacity, closing, bounds, no-ink); the rest cover what the package never tested in isolation:
// folding operations into visible marks, the stroke shapes, and erasing by reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPointsForTool, markTargetKey, marksToSvg, materializeMarkRecords, nearestMarkPathRef, readMarkOperationRecords,
  readMarkTools, toolEmitsClosedSet, toolErases,
} from '../do-work/ink.mjs';

const pt = (x, y) => ({ values: [x, y] });
const operation = (id, address, points, extra = {}) => ({
  id,
  target: { address },
  ...extra,
  body: { coordinate_sets: [{ id: `${id}:set`, points: points.map(([x, y]) => pt(x, y)), closed: extra.closed }], effects: extra.effects ?? {}, ...(extra.style ? { style: extra.style } : {}) },
});
const pathOf = (ref, points, style, closed) => ({
  ref, targetKey: 't', coordinateSet: { id: ref, points: points.map(([x, y]) => pt(x, y)), closed }, operation: { id: ref }, style: style ?? null, order: 0,
});
const material = paths => ({ targetKey: 't', paths, hiddenRefs: [], operations: [], unrendered: [] });

test('an export path follows the points with the style stroke, width and opacity', () => {
  const { svg } = marksToSvg(material([pathOf('a', [[10, 10], [20, 30], [40, 5]], { stroke: '#ef4444', strokeWidth: 4, strokeOpacity: 0.8 })]));
  for (const part of ['d="M 10 10 L 20 30 L 40 5"', 'stroke="#ef4444"', 'stroke-width="4"', 'stroke-opacity="0.8"', 'fill="none"', 'stroke-linecap="round"']) assert.ok(svg.includes(part), part);
});

test('a closed set ends with Z; bounds span every stroke; width 3 and opacity 1 when the style says nothing', () => {
  assert.ok(marksToSvg(material([pathOf('a', [[0, 0], [10, 0], [10, 10]], { stroke: '#000' }, true)])).svg.includes('d="M 0 0 L 10 0 L 10 10 Z"'));
  const { svg, bounds } = marksToSvg(material([pathOf('a', [[10, 20], [30, 5]], { stroke: '#000' }), pathOf('b', [[-5, 40], [100, 12]], { stroke: '#000' })]));
  assert.deepEqual(bounds, { minX: -5, minY: 5, maxX: 100, maxY: 40 });
  assert.ok(svg.includes('stroke-width="3"') && svg.includes('stroke-opacity="1"'));
});

test('a style with only a colour token takes the caller\'s default stroke; with no default the export is refused', () => {
  const tokenOnly = material([pathOf('a', [[0, 0], [1, 1]], { strokeToken: '--ink' })]);
  const { svg } = marksToSvg(tokenOnly, { defaultStroke: '#123456' });
  assert.ok(svg.includes('stroke="#123456"') && !svg.includes('var('));
  assert.throws(() => marksToSvg(tokenOnly), /no colour/);
});

test('no ink gives an empty fragment and null bounds; an empty point set is skipped', () => {
  assert.deepEqual(marksToSvg(material([])), { svg: '', bounds: null });
  assert.deepEqual(marksToSvg(material([pathOf('a', [])])), { svg: '', bounds: null });
});

test('only the marks on the named target are visible, in the order they were made', () => {
  const operations = [operation('b', 'wall', [[0, 0], [1, 1]], { sequence: 2 }), operation('a', 'wall', [[2, 2], [3, 3]], { sequence: 1 }), operation('c', 'floor', [[9, 9], [8, 8]], { sequence: 3 })];
  const shown = materializeMarkRecords({ operations, target: { address: 'wall' } });
  assert.deepEqual(shown.paths.map(path => path.operation.id), ['a', 'b']);
  assert.equal(materializeMarkRecords({ operations }).paths.length, 3);
  assert.notEqual(markTargetKey({ address: 'wall' }), markTargetKey({ address: 'floor' }));
  assert.equal(markTargetKey({ address: 'wall', readerKey: 'k' }), markTargetKey({ address: 'wall' }, 'k'));
});

test('rows may arrive as payloads or as stored JSON text', () => {
  const stored = { value_json: JSON.stringify(operation('s', 'wall', [[0, 0], [4, 4]])) };
  const wrapped = { payload: operation('p', 'wall', [[1, 1], [2, 2]]) };
  assert.deepEqual(readMarkOperationRecords([stored, wrapped]).map(row => row.id).sort(), ['p', 's']);
});

test('a later operation hides, restyles, reorders, copies and merges earlier marks by reference', () => {
  const base = [operation('one', 'wall', [[0, 0], [1, 0]], { styleRef: 'pen', sequence: 1 }), operation('two', 'wall', [[0, 1], [1, 1]], { styleRef: 'pen', sequence: 2 })];
  const styles = [{ id: 'pen', stroke: '#111', stroke_width: 2 }, { id: 'marker', stroke: '#f00', stroke_width: 9 }];
  const fold = effects => materializeMarkRecords({ operations: [...base, { id: 'fx', sequence: 3, target: { address: 'wall' }, body: { effects } }], styles, target: { address: 'wall' } });

  assert.deepEqual(fold({ hide_refs: ['one:set:0'] }).paths.map(path => path.ref), ['two:set:0']);
  assert.equal(fold({ style_ref_by_ref: { 'one:set:0': 'marker' } }).paths.find(path => path.ref === 'one:set:0').style.stroke, '#f00');
  assert.deepEqual(fold({ order_by_ref: { 'one:set:0': 5 } }).paths.map(path => path.ref), ['two:set:0', 'one:set:0']);
  assert.deepEqual(fold({ copy_ref_by_ref: { 'one:set:0': ['half-a', 'half-b'] } }).paths.map(path => path.ref).sort(), ['half-a', 'half-b', 'one:set:0', 'two:set:0']);
  const merged = fold({ merge_refs: [{ ref: 'both', refs: ['one:set:0', 'two:set:0'] }] }).paths.find(path => path.ref === 'both');
  assert.equal(merged.coordinateSet.points.length, 4);
});

test('a mark\'s own style fields win over the style it names, which is left alone', () => {
  const operations = [operation('one', 'wall', [[0, 0], [1, 1]], { styleRef: 'pen', style: { stroke_width: 11 } }), operation('two', 'wall', [[2, 2], [3, 3]], { styleRef: 'pen' })];
  const { paths } = materializeMarkRecords({ operations, styles: [{ id: 'pen', stroke: '#111', stroke_width: 2 }], target: { address: 'wall' } });
  const byOp = Object.fromEntries(paths.map(path => [path.operation.id, path.style]));
  assert.equal(byOp.one.strokeWidth, 11);
  assert.equal(byOp.one.stroke, '#111');
  assert.equal(byOp.two.strokeWidth, 2);
});

test('tool rows choose the shape of a stroke: freehand, line, rectangle corners and N-sided figures', () => {
  const stroke = [pt(0, 0), pt(3, 9), pt(10, 4)];
  const tool = mapper => readMarkTools([{ id: 't', mapper }])[0];
  assert.equal(mapPointsForTool(tool(undefined), stroke), stroke);
  assert.equal(mapPointsForTool(tool({ kind: 'surprise' }), stroke), stroke);
  assert.deepEqual(mapPointsForTool(tool({ kind: 'segment' }), stroke), [stroke[0], stroke[2]]);
  assert.deepEqual(mapPointsForTool(tool({ kind: 'polygon', corners: true }), stroke).map(point => point.values), [[0, 0], [10, 0], [10, 4], [0, 4]]);
  const ring = mapPointsForTool(tool({ kind: 'polygon', sides: 18 }), [pt(0, 0), pt(10, 10)]);
  assert.equal(ring.length, 18);
  for (const point of ring) assert.ok(Math.abs(Math.hypot(point.values[0] - 5, point.values[1] - 5) - 5) < 1e-9);
  assert.deepEqual(mapPointsForTool(tool({ kind: 'polygon', sides: 2 }), stroke), stroke);
  assert.equal(mapPointsForTool(tool({ kind: 'segment' }), [pt(1, 1)]).length, 1);
});

test('a tool row says whether it closes its figure and whether it erases', () => {
  assert.equal(toolEmitsClosedSet(readMarkTools([{ id: 'a', mapper: { kind: 'polygon', sides: 4, closed: true } }])[0]), true);
  assert.equal(toolEmitsClosedSet(readMarkTools([{ id: 'b', body: { coordinate_set: { closed: true } } }])[0]), true);
  assert.equal(toolEmitsClosedSet(readMarkTools([{ id: 'c' }])[0]), false);
  assert.equal(toolErases(readMarkTools([{ id: 'e', mode: 'erase' }])[0]), true);
  assert.equal(toolErases(readMarkTools([{ id: 'p' }])[0]), false);
});

test('erasing finds the nearest visible mark within the radius, along segments and around closed shapes', () => {
  const operations = [operation('line', 'wall', [[0, 0], [10, 0]]), operation('box', 'wall', [[20, 0], [30, 0], [30, 10]], { closed: true })];
  const shown = materializeMarkRecords({ operations, target: { address: 'wall' } });
  assert.equal(nearestMarkPathRef(shown, pt(5, 1), 2), 'line:set:0');
  assert.equal(nearestMarkPathRef(shown, pt(5, 5), 2), null);
  assert.equal(nearestMarkPathRef(shown, pt(25, 5), 2), 'box:set:0');
});

test('a hidden mark is no longer found by the eraser', () => {
  const operations = [operation('line', 'wall', [[0, 0], [10, 0]]), { id: 'gone', target: { address: 'wall' }, body: { effects: { hide_refs: ['line:set:0'] } } }];
  assert.equal(nearestMarkPathRef(materializeMarkRecords({ operations, target: { address: 'wall' } }), pt(5, 0), 3), null);
});

test('the export of a target holds its marks and not another target\'s', () => {
  const operations = [operation('a', 'wall', [[10, 10], [20, 30]], { style: { stroke: '#000' } }), operation('b', 'floor', [[100, 100], [200, 200]], { style: { stroke: '#000' } })];
  const { svg, bounds } = marksToSvg(materializeMarkRecords({ operations, target: { address: 'wall' } }));
  assert.ok(svg.includes('d="M 10 10 L 20 30"') && !svg.includes('100 100'));
  assert.deepEqual(bounds, { minX: 10, minY: 10, maxX: 20, maxY: 30 });
});
