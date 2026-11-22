// test/screen-helpers-stock-mac.test.mjs
// The two programs that touch the Mac (read-data/screen-driver.js and read-data/observe-visual.js) need nothing an
// ordinary Mac lacks: they are JavaScript for Automation run by /usr/bin/osascript. The Swift scripts they replaced were
// run by /usr/bin/swift, which needs Xcode's xcrun, so inside a computer run's sandbox every look and drive failed before
// it started ("xcrun: error: unable to load libxcrun ... file system sandbox blocked open()", 1:16 and 1:22 AM CST Nov 22 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screenSettings } from '../read-data/drive-the-screen.mjs';
import { ocrPixels } from '../read-data/observe-visual.mjs';

const READ_DATA = new URL('../read-data/', import.meta.url).pathname;
const driver = join(READ_DATA, 'screen-driver.js');
const onMac = { skip: process.platform !== 'darwin' };
const ask = (request, raw = false) => spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', driver], { input: raw ? request : JSON.stringify(request), encoding: 'utf8', timeout: 60_000 });

test('the driver and the text reader are started by a program every Mac has, and no Swift is left to start', () => {
  const settings = screenSettings();
  assert.equal(settings.driver.program, '/usr/bin/osascript');
  assert.deepEqual(settings.driver.arguments, ['-l', 'JavaScript']);
  assert.equal(settings.driver.script, 'screen-driver.js');
  assert.deepEqual(readdirSync(READ_DATA).filter(name => name.endsWith('.swift')), []);
  for (const name of readdirSync(READ_DATA).filter(file => /\.(mjs|json)$/.test(file))) {
    assert.equal(readFileSync(join(READ_DATA, name), 'utf8').includes('/usr/bin/swift'), false, `${name} starts no Swift`);
  }
});

test('the real driver answers a read in the shape the screen tools read', onMac, () => {
  const done = ask({ command: 'read', max_nodes: 3 });
  assert.equal(done.status, 0, done.stderr);
  const read = JSON.parse(done.stdout);
  assert.deepEqual(Object.keys(read).sort(), ['app', 'displays', 'elements', 'frontmost', 'readiness', 'secure_input', 'truncated']);
  assert.deepEqual(Object.keys(read.readiness).sort(), ['ax_trusted', 'screen_capture', 'screen_locked']);
  assert.equal(typeof read.secure_input.enabled, 'boolean');
  assert.ok(read.displays.length >= 1);
  assert.equal(read.displays[0].main, true);
  assert.ok(read.elements.length <= 3);
  for (const element of read.elements) {
    assert.ok(Array.isArray(element.path) && element.path.length === element.depth);
    if (element.frame) assert.deepEqual(Object.keys(element.frame).sort(), ['height', 'width', 'x', 'y']);
  }
  const none = JSON.parse(ask({ command: 'read', max_nodes: 0 }).stdout);
  assert.deepEqual(none.elements, []);
});

test('the real driver refuses a request it cannot read, an unknown command and an act with no app, in words, with exit 2', onMac, () => {
  const garbled = ask('not json', true);
  assert.equal(garbled.status, 2);
  assert.match(garbled.stderr, /A command is needed\./);
  const unknown = ask({ command: 'shrug' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command\./);
  const read = JSON.parse(ask({ command: 'read', max_nodes: 0 }).stdout);
  const nobody = ask({ command: 'act', events: [] });
  if (read.readiness.screen_locked) {
    // Nothing is dispatched into a locked screen, and that is said before anything else is checked.
    assert.equal(nobody.status, 0);
    assert.deepEqual(JSON.parse(nobody.stdout), { events: [], completed: false, refused: 'screen_locked' });
  } else {
    assert.equal(nobody.status, 2);
    assert.match(nobody.stderr, /A target app process is needed\./);
  }
});

test('the real driver watches the stop key when asked and says so; an event with no kind ends the run', onMac, () => {
  const read = JSON.parse(ask({ command: 'read', max_nodes: 0 }).stdout);
  const acted = JSON.parse(ask({ command: 'act', pid: process.pid, stop: { enabled: true, key_code: 53, marker: 7210 }, events: [{ event: 'pause', ms: 30 }, { ms: 1 }] }).stdout);
  if (read.readiness.screen_locked) { assert.equal(acted.refused, 'screen_locked'); return; }
  assert.equal(typeof acted.stop_key_watched, 'boolean');
  assert.equal(acted.stopped_by_person, false);
  assert.deepEqual(acted.events, [{ event: 'pause', ok: true, detail: '' }, { ok: false, detail: 'An event needs its kind.' }]);
  assert.equal(acted.completed, false);
  assert.deepEqual(acted.released, []);
});

test('the real text reader reads the words of a picture, with bounds normalized to the picture and its own size', onMac, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'screen-helpers-'));
  const picture = join(folder, 'words.png');
  const draw = join(folder, 'draw.js');
  writeFileSync(draw, [
    "ObjC.import('AppKit');",
    'function run(argv) {',
    '  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(600, 160));',
    '  image.lockFocus;',
    '  $.NSColor.whiteColor.setFill; $.NSRectFill($.NSMakeRect(0, 0, 600, 160));',
    "  $('Hello quiet screen').drawAtPointWithAttributes($.NSMakePoint(20, 90), $({ NSFont: $.NSFont.systemFontOfSize(36) }));",
    '  image.unlockFocus;',
    '  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);',
    '  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[0], true);',
    "  return '';",
    '}',
  ].join('\n'));
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', draw, picture]);
  const seen = await ocrPixels(readFileSync(picture));
  assert.ok(seen.width > 0 && seen.height > 0);
  const line = seen.lines.find(row => row.text === 'Hello quiet screen');
  assert.ok(line, JSON.stringify(seen.lines));
  assert.ok(line.confidence > 0.5);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(line[key] >= 0 && line[key] <= 1, `${key} is normalized`);
  await assert.rejects(ocrPixels(Buffer.from('not a picture')), /Could not decode image pixels/);
});
