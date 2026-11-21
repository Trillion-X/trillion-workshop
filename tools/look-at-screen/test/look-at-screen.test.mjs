// tools/look-at-screen/test/look-at-screen.test.mjs
//
// The tool's behaviour against stand-ins for the system's commands (nothing here takes a real picture of anyone's screen):
// every display comes back, the main one first, with its size; the long edge is capped by the rules; the pointer is
// asked for only when the request says so; the folder the pictures are made in is always removed; and missing Screen
// Recording access is said in words, whether the system's preflight or the capture itself refuses.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { look, lookAtScreen, lookAtWindow, pictureAnAppWindow, rules, systemCommands } from '../do-work/look-at-screen.mjs';

// Stand-in commands that record what they were asked and make real files, as the system would.
function standIn({ windowsOf = () => [], displays = 2, allowed = true, captureError, sizes = [{ width: 1600, height: 900 }, { width: 1200, height: 750 }], bytesAt } = {}) {
  const calls = { capture: [], shrink: [], windows: [], captureWindow: [] };
  return {
    calls,
    windows: owner => { calls.windows.push(owner); return { allowed, windows: windowsOf(owner) }; },
    captureWindow: (id, file) => {
      calls.captureWindow.push(id);
      if (captureError) throw captureError;
      writeFileSync(file, `window ${id}`);
    },
    screens: () => ({ displays, allowed }),
    capture: (files, cursor) => {
      calls.capture.push({ files, cursor });
      if (captureError) throw captureError;
      files.forEach((file, at) => writeFileSync(file, `display ${at + 1}`));
    },
    shrink: (from, to, longEdge, format) => { calls.shrink.push({ longEdge, format }); writeFileSync(to, bytesAt ? Buffer.alloc(bytesAt(longEdge), 7) : `small ${from}`); },
    size: file => sizes[Number(file.match(/small-(\d+)/)[1]) - 1] ?? sizes[0],
  };
}

const scratch = () => tempFolder(join(tmpdir(), 'look-test-'));
const leftIn = folder => readdirSync(folder);

test('every display comes back, the main one first, with its exact pixel size and its picture', () => {
  const tmp = scratch();
  try {
    const commands = standIn();
    const answer = look({}, commands, { tmp });
    assert.deepEqual(answer.pictures.map(({ display, main, width, height }) => ({ display, main, width, height })), [
      { display: 1, main: true, width: 1600, height: 900 },
      { display: 2, main: false, width: 1200, height: 750 },
    ]);
    assert.ok(answer.pictures.every(picture => picture.media_type === 'image/jpeg'));
    assert.match(Buffer.from(answer.pictures[0].base64, 'base64').toString(), /^small .*display-1\.png$/);
    assert.equal(answer.said, rules.words.done);
    assert.ok(!Number.isNaN(Date.parse(answer.looked_at)));
    assert.deepEqual(commands.calls.capture[0].files.map(file => file.split('/').pop()), ['display-1.png', 'display-2.png']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a request may ask for smaller pictures and never larger than the rules allow', () => {
  const tmp = scratch();
  try {
    const small = standIn({ displays: 1 });
    look({ long_edge: 400 }, small, { tmp });
    assert.equal(small.calls.shrink[0].longEdge, 400);
    const huge = standIn({ displays: 1 });
    look({ long_edge: 99999 }, huge, { tmp });
    assert.equal(huge.calls.shrink[0].longEdge, rules.long_edge);
    assert.equal(huge.calls.shrink[0].format, rules.format);
    assert.throws(() => look({ long_edge: 0 }, standIn(), { tmp }), /long_edge must be a number of pixels/);
    assert.throws(() => look('wide', standIn(), { tmp }), /must be an object/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('pictures too large for one answer are made smaller until they fit, and the answer stays under the most a run may return', () => {
  const tmp = scratch();
  try {
    // A picture takes as many bytes as its edge squared divided by ten, so 1600 is 256000 bytes before it is written as base64.
    const commands = standIn({ displays: 2, bytesAt: edge => Math.floor(edge * edge / 10) });
    const answer = look({}, commands, { tmp });
    const edges = commands.calls.shrink.map(call => call.longEdge);
    assert.equal(edges[0], rules.long_edge);
    assert.ok(edges.at(-1) < rules.long_edge);
    assert.ok(JSON.stringify(answer).length <= rules.max_answer_bytes);
    assert.equal(answer.pictures.length, 2);
    assert.ok(edges.every((edge, at) => at < 2 || edge <= edges[at - 2]), 'each try is smaller than the one before');
    const small = standIn({ displays: 1, bytesAt: () => 1000 });
    look({}, small, { tmp });
    assert.equal(small.calls.shrink.length, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('more displays than fit even at the smallest picture are told in words, not cut off', () => {
  const tmp = scratch();
  try {
    const commands = standIn({ displays: 3, bytesAt: () => 100_000 });
    const answer = look({}, commands, { tmp });
    assert.deepEqual(answer, { error: rules.words.too_many_displays });
    assert.equal(commands.calls.shrink.at(-1).longEdge, rules.least_long_edge);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the pointer is in the picture only when the request asks for it', () => {
  const tmp = scratch();
  try {
    const without = standIn({ displays: 1 });
    look({}, without, { tmp });
    assert.equal(without.calls.capture[0].cursor, false);
    const withPointer = standIn({ displays: 1 });
    look({ cursor: true }, withPointer, { tmp });
    assert.equal(withPointer.calls.capture[0].cursor, true);
    const notTrue = standIn({ displays: 1 });
    look({ cursor: 'yes' }, notTrue, { tmp });
    assert.equal(notTrue.calls.capture[0].cursor, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('nothing is kept on the Mac: the folder is removed after a picture, a refusal and a failure', () => {
  const tmp = scratch();
  try {
    look({}, standIn(), { tmp });
    look({}, standIn({ allowed: false }), { tmp });
    look({}, standIn({ captureError: new Error('the display went away') }), { tmp });
    assert.deepEqual(leftIn(tmp), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('Screen Recording off is said in words and nothing is captured', () => {
  const tmp = scratch();
  try {
    const commands = standIn({ allowed: false });
    const answer = look({}, commands, { tmp });
    assert.deepEqual(answer, { needs_access: 'screen-recording', said: rules.words.needs_access });
    assert.deepEqual(commands.calls.capture, []);
    assert.doesNotMatch(rules.words.needs_access, /Trillion/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a capture the system refuses is told the same way as a preflight that says no; any other failure is an error', () => {
  const tmp = scratch();
  try {
    const refused = Object.assign(new Error('screencapture failed'), { stderr: 'could not create image from display' });
    assert.equal(look({}, standIn({ captureError: refused }), { tmp }).needs_access, 'screen-recording');
    const broken = look({}, standIn({ captureError: new Error('x'.repeat(900)) }), { tmp });
    assert.equal(broken.needs_access, undefined);
    assert.equal(broken.error.length, 400);
    assert.equal(broken.pictures, undefined);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the real preflight answers on this Mac with a display count and a yes or no, and takes no picture', { skip: process.platform !== 'darwin' }, () => {
  const { displays, allowed } = systemCommands.screens();
  assert.ok(Number.isInteger(displays) && displays >= 1);
  assert.equal(typeof allowed, 'boolean');
  assert.equal(typeof lookAtScreen, 'function');
});

// Windows as the window server lists them, front to back: an app's menu bar item (layer 25) can be in front of its window.
const twoApps = owner => ({
  Notes: [{ id: 7, name: '', layer: 25 }, { id: 9, name: 'Shopping', layer: 0 }, { id: 4, name: 'Older', layer: 0 }],
  Mail: [{ id: 3, name: 'Inbox', layer: 0 }],
}[owner] ?? []);

test('an app\'s frontmost ordinary window is pictured by its own id, and only the app the request names is asked for', () => {
  const tmp = scratch();
  try {
    const commands = standIn({ windowsOf: twoApps });
    const answer = lookAtWindow({ owner_name: 'Notes' }, commands, { tmp });
    assert.deepEqual(commands.calls.windows, ['Notes']);
    assert.deepEqual(commands.calls.captureWindow, [9]);
    assert.deepEqual(answer.window, { id: 9, name: 'Shopping', owner: 'Notes' });
    assert.equal(answer.picture.media_type, 'image/jpeg');
    assert.match(Buffer.from(answer.picture.base64, 'base64').toString(), /^small .*window\.png$/);
    assert.equal(answer.said, rules.words.window_done);
    assert.ok(!Number.isNaN(Date.parse(answer.looked_at)));
    assert.deepEqual(commands.calls.capture, [], 'no display is captured');
    assert.deepEqual(leftIn(tmp), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('an app with no ordinary window on screen is said in words, and nothing is captured', () => {
  const tmp = scratch();
  try {
    for (const owner of ['Calendar', 'Menus']) {
      const commands = standIn({ windowsOf: name => (name === 'Menus' ? [{ id: 2, name: '', layer: 25 }] : []) });
      assert.deepEqual(lookAtWindow({ owner_name: owner }, commands, { tmp }), { no_window: owner, said: rules.words.no_window });
      assert.deepEqual(commands.calls.captureWindow, []);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a window request names its app, may ask for a smaller picture, and Screen Recording off or refused is said in words', () => {
  const tmp = scratch();
  try {
    for (const bad of [{}, { owner_name: '' }, { owner_name: '  ' }, { owner_name: 7 }]) {
      assert.throws(() => lookAtWindow(bad, standIn(), { tmp }), /owner_name is the name of the app/);
    }
    const small = standIn({ windowsOf: twoApps });
    lookAtWindow({ owner_name: 'Mail', long_edge: 500 }, small, { tmp });
    assert.equal(small.calls.shrink[0].longEdge, 500);
    const off = standIn({ windowsOf: twoApps, allowed: false });
    assert.deepEqual(lookAtWindow({ owner_name: 'Mail' }, off, { tmp }), { needs_access: 'screen-recording', said: rules.words.needs_access });
    assert.deepEqual(off.calls.captureWindow, []);
    const refused = Object.assign(new Error('screencapture failed'), { stderr: 'could not create image from window' });
    assert.equal(lookAtWindow({ owner_name: 'Mail' }, standIn({ windowsOf: twoApps, captureError: refused }), { tmp }).needs_access, 'screen-recording');
    const huge = standIn({ windowsOf: twoApps, bytesAt: () => 300_000 });
    assert.deepEqual(lookAtWindow({ owner_name: 'Mail' }, huge, { tmp }), { error: rules.words.too_large });
    assert.deepEqual(leftIn(tmp), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the real window list answers on this Mac with a yes or no and a list, and takes no picture', { skip: process.platform !== 'darwin' }, () => {
  const { allowed, windows } = systemCommands.windows('an app that is not running anywhere');
  assert.equal(typeof allowed, 'boolean');
  assert.deepEqual(windows, []);
  assert.equal(typeof pictureAnAppWindow, 'function');
});
