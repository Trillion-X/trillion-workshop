// tools/build-a-screen-as-an-ai-writes-it/test/screen-spec.test.mjs
//
// Moved from old trillion test/screen-spec.test.mjs:1-120 with its assertions unchanged: the spec as lines complete, bad
// lines and elements left out and said, bound values resolved without running anything, and applyPatch. The tests after
// line 120 read the React parts (parts/ui, src/workspace/declared-parts.ts), make_screen (src/screen-view.mjs) and the AI
// app bridge, which have not moved; they stay in old trillion until those move.
//
// A screen made of shared parts, as an AI sends it (src/screen-spec.mjs): lines become the spec as they complete, an
// element no line touched keeps its identity, a bad line or element is left out and said without stopping the rest,
// bound values resolve without running anything, every declared part has its component, make_screen keeps the finished
// lines as the person's tool, and the AI app bridge hands the growing arguments of a call to the view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { boundPath, checkElement, checkSpec, conditionHolds, declaredParts, partsGuide, resolveValue, specFromText, specStream } from '../src/screen-spec.mjs';
import { applyPatch } from '../src/view-patch.mjs';

const line = value => JSON.stringify(value);
const LINES = [
  line({ op: 'add', path: '/root', value: 'main' }),
  line({ op: 'add', path: '/elements/main', value: { type: 'Card', props: {}, children: ['title', 'more'] } }),
  line({ op: 'add', path: '/elements/title', value: { type: 'Text', props: { text: 'Hello' } } }),
  line({ op: 'add', path: '/elements/more', value: { type: 'Button', props: { label: 'More' } } }),
];

test('lines become the spec as each completes; an element no line touched keeps its identity', () => {
  const stream = specStream();
  const half = `${LINES[0]}\n${LINES[1]}\n${LINES[2].slice(0, 20)}`;
  const first = stream.push(half);
  assert.deepEqual([...first.changed].sort(), ['elements/main', 'root']);
  assert.deepEqual(Object.keys(first.spec.elements), ['main'], 'a line still being written is not applied');
  const second = stream.push(`${LINES.join('\n')}\n`);
  assert.deepEqual([...second.changed].sort(), ['elements/more', 'elements/title']);
  assert.equal(second.spec.elements.main, first.spec.elements.main, 'main kept its identity while two more elements arrived');
  const last = stream.end(`${LINES.join('\n')}\n${line({ op: 'replace', path: '/elements/title/props/text', value: 'Hi' })}`);
  assert.equal(last.spec.elements.title.props.text, 'Hi', 'end takes a last line with no line break');
  assert.equal(last.spec.elements.more, second.spec.elements.more);
  assert.equal(stream.push('something else entirely\n').restarted, true, 'a stream that does not continue the text starts again');
});

test('a bad line is left out and said; the lines after it still apply', () => {
  const { spec, said } = specFromText([
    LINES[0],
    '{"op":"add","path":"/elements/x",',
    line({ op: 'move', path: '/root', from: '/x' }),
    line({ op: 'add', path: '/secret', value: 1 }),
    line({ op: 'add', path: '/elements/a/props/text', value: 'deep' }),
    LINES[1],
    line({ op: 'add', path: '/state/filters/kind', value: 'open' }),
  ].join('\n'));
  assert.equal(said.length, 3);
  assert.match(said[0], /Line 2 is not a change: it is not complete JSON/);
  assert.match(said[1], /"move" is not a change a screen takes/);
  assert.match(said[2], /changes \/secret; a line may change only/);
  assert.deepEqual(spec.elements.a, { props: { text: 'deep' } }, 'a missing parent is made, not refused');
  assert.deepEqual(spec.state, { filters: { kind: 'open' } });
  assert.equal(spec.root, 'main');
  const whole = specFromText(line({ root: 'r', elements: { r: { type: 'Text', props: { text: 'At once' } } } }));
  assert.equal(whole.spec.elements.r.props.text, 'At once', 'a whole spec on one line is taken too');
});

test('every element is checked against its part: fixed where it can be, unusable with words where not', () => {
  const requests = { save: { method: 'POST', path: '/work/api/lists/l/rows' } };
  const fixed = checkElement('go', { type: 'button', props: { label: 7, variant: 'PRIMARY', size: 'huge', colour: 'red', on: { press: { action: 'save' } } } }, { requests });
  assert.equal(fixed.usable, true);
  assert.deepEqual(fixed.element, { type: 'Button', props: { label: '7', variant: 'primary' }, on: { press: [{ action: 'save' }] } });
  assert.equal(fixed.fixes.length, 6, fixed.fixes.join('\n'));
  const noAction = checkElement('go', { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'delete_everything' }, hover: { action: 'save' } } }, { requests });
  assert.deepEqual(noAction.element.on, {}, 'an undeclared action and an event the part has not are both left out');
  const missing = checkElement('t', { type: 'Text', props: {} });
  assert.equal(missing.usable, false);
  assert.match(missing.problems[0], /t: Text needs text/);
  assert.match(checkElement('s', { type: 'Spaceship' }).problems[0], /"Spaceship" is not a part screens can use/);
  assert.equal(checkElement('n', 'not an element').usable, false);
  assert.deepEqual(checkElement('t', { type: 'Text', props: { text: 'x' }, children: ['y'] }).element.children, [], 'a part that holds nothing holds no children');
  const slider = checkElement('s', { type: 'Slider', props: { label: 'Warmth', value: '40', step: -2, min: 0, max: 100 } });
  assert.deepEqual(slider.element.props, { label: 'Warmth', value: 40, step: 0, min: 0, max: 100 });
  const bound = checkElement('s', { type: 'Slider', props: { label: 'Warmth', value: { $bindState: '/warmth' } } });
  assert.deepEqual(bound.element.props.value, { $bindState: '/warmth' }, 'a bound value is checked when it is drawn, not before');
});

test('the whole spec: children never sent are left out, reads must be declared GET requests, the root must exist', () => {
  const requests = { rows: { method: 'GET', path: '/work/api/lists/l' }, save: { method: 'POST', path: '/work/api/lists/l/rows' } };
  const { spec, fixes, problems } = checkSpec({ root: 'main', elements: { main: { type: 'Card', props: {}, children: ['a', 'gone'] }, a: { type: 'Divider' } }, reads: { '/rows': { request: 'rows' }, '/x': { request: 'save' } } }, { requests });
  assert.deepEqual(spec.elements.main.children, ['a']);
  assert.deepEqual(Object.keys(spec.reads), ['/rows']);
  assert.equal(fixes.length, 2);
  assert.deepEqual(problems, []);
  assert.match(checkSpec({ elements: {} }).problems[0], /names no root/);
  assert.match(checkSpec({ root: 'x', elements: {} }).problems[0], /The root "x" was never sent/);
  assert.deepEqual(checkSpec({ root: 'x', elements: {} }, { complete: false }).problems, [], 'while the stream runs a missing root is not yet a problem');
});

test('bound values are looked up, never run', () => {
  const scope = { state: { name: 'Ruth', rows: [{ title: 'A' }, { title: 'B' }], n: 3 }, item: { title: 'B', done: true }, index: 1, itemPath: '/rows/1', event: 'typed' };
  assert.equal(resolveValue({ $state: '/name' }, scope), 'Ruth');
  assert.equal(resolveValue({ $item: 'title' }, scope), 'B');
  assert.equal(resolveValue({ $index: true }, scope), 1);
  assert.equal(resolveValue({ $event: true }, scope), 'typed');
  assert.equal(resolveValue({ $template: 'Hi ${/name}, ${/n} left${/nothing}' }, scope), 'Hi Ruth, 3 left');
  assert.equal(resolveValue({ $cond: { $state: '/n', gt: 2 }, $then: 'many', $else: 'few' }, scope), 'many');
  assert.deepEqual(resolveValue({ tiles: [{ id: { $item: 'title' } }] }, scope), { tiles: [{ id: 'B' }] });
  assert.equal(resolveValue({ $template: '${constructor}${/constructor}' }, scope), '', 'a template reads the state\'s own values only');
  assert.equal(resolveValue({ $state: '/rows/length' }, scope), 2, 'a list\'s own length is readable');
  assert.equal(boundPath({ $bindState: '/name' }, scope), '/name');
  assert.equal(boundPath({ $bindItem: 'done' }, scope), '/rows/1/done');
  assert.equal(boundPath('plain', scope), null);
  assert.equal(conditionHolds({ $or: [{ $state: '/missing' }, { $item: 'done' }] }, scope), true);
  assert.equal(conditionHolds([{ $state: '/name', eq: 'Ruth' }, { $index: true, lt: 1 }], scope), false);
  assert.equal(conditionHolds({ $state: '/rows', not: true }, scope), false);
});

test('applyPatch changes only the path it touches and leaves the model given as it was', () => {
  const model = { elements: { a: { props: { x: 1 } }, b: { props: { y: 2 } } }, list: [1, 2] };
  const next = applyPatch(model, [{ op: 'replace', path: '/elements/a/props/x', value: 5 }, { op: 'add', path: '/list/-', value: 3 }]);
  assert.equal(next.elements.b, model.elements.b);
  assert.notEqual(next.elements.a, model.elements.a);
  assert.deepEqual(model, { elements: { a: { props: { x: 1 } }, b: { props: { y: 2 } } }, list: [1, 2] });
  assert.deepEqual(next.list, [1, 2, 3]);
  assert.throws(() => applyPatch(model, [{ op: 'add', path: '/nothing/here', value: 1 }]), /Nothing at/);
});

