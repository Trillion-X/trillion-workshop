// tools/look-at-screen/do-work/look-at-screen.mjs
//
// The Workshop tools "Look at my screen" and "Picture an app's window": a picture of what is on the person's Mac screen
// right now, for their AI to see. "Look at my screen" captures every display, the main one first; "Picture an app's
// window" captures only the frontmost on-screen window of the app the request names, by the window's own id, so nothing
// else on the screen is in it. Each picture is labelled with its exact pixel size so an AI can point at a spot. Run as a
// function by tools/workflows/do-work/run-a-function.mjs on the person's own Mac.
//
// Invariants:
// - It looks only when run; nothing is captured in the background. A window is only read: no click, key, focus or move
//   is sent to it, so a window the person is using is not touched.
// - Pictures are returned to the run and nowhere else; the folder they are made in is removed before the run ends,
//   whether the capture worked or not.
// - Missing Screen Recording access is said in words, never answered with a blank picture: the system's own
//   preflight is asked before anything is captured, and a capture the system refuses is told the same way.
// - Size, format and the most one answer may hold are DATA (read-data/rules.json); a request may ask for smaller
//   pictures, never larger, and the pictures are made smaller until the answer fits what a run may return.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const rules = JSON.parse(readFileSync(new URL('../read-data/rules.json', import.meta.url), 'utf8'));

// The system's screen-capture preflight and its display count, from one call into AppKit and CoreGraphics.
const ASK_THE_SYSTEM = 'ObjC.import("AppKit"); ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); '
  + 'JSON.stringify({ displays: Number($.NSScreen.screens.count), allowed: $.CGPreflightScreenCaptureAccess() })';

// The on-screen windows of one app, front to back (the window server's own order), with the screen-capture preflight,
// from one call into CoreGraphics. Layer 0 is an ordinary window; menus, the menu bar item and overlays have other layers.
const LIST_WINDOWS = 'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); '
  + 'function run(argv) { const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo('
  + '$.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || []; '
  + 'return JSON.stringify({ allowed: $.CGPreflightScreenCaptureAccess(), windows: all.filter(w => w.kCGWindowOwnerName === argv[0])'
  + '.map(w => ({ id: w.kCGWindowNumber, name: w.kCGWindowName || "", layer: w.kCGWindowLayer })) }); }';

// The commands this tool runs, each one call; a test hands in stand-ins.
export const systemCommands = {
  screens: () => JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ASK_THE_SYSTEM], { encoding: 'utf8' })),
  // -x: no sound; -C: the pointer too. One file name per display, the main display first.
  capture: (files, cursor) => { execFileSync('/usr/sbin/screencapture', ['-x', ...(cursor ? ['-C'] : []), ...files]); },
  windows: owner => JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', LIST_WINDOWS, owner], { encoding: 'utf8' })),
  // -l: only the window with this id, as it is drawn now, even when another window covers it; -o: without its shadow.
  captureWindow: (id, file) => { execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(id), file]); },
  shrink: (from, to, longEdge, format) => { execFileSync('/usr/bin/sips', ['-Z', String(longEdge), '-s', 'format', format === 'jpg' ? 'jpeg' : format, from, '--out', to], { stdio: 'ignore' }); },
  size: file => {
    const said = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    return { width: Number(said.match(/pixelWidth: (\d+)/)?.[1]), height: Number(said.match(/pixelHeight: (\d+)/)?.[1]) };
  },
};

const MEDIA = { jpg: 'image/jpeg', png: 'image/png' };
// The bytes the answer takes: the pictures as they are written, and the fixed words round them.
const answerBytes = pictures => JSON.stringify({ pictures, said: rules.words.done, looked_at: '2000-01-01T00:00:00.000Z' }).length;
const REFUSED = /not permitted|could not create image|declined|not authorized/i;

// The edge a request asks for, never larger than the rules allow.
function askedEdge(input) {
  if (input !== null && typeof input !== 'object') throw new Error('The request must be an object.');
  const longEdge = Math.min(input?.long_edge ?? rules.long_edge, rules.long_edge);
  if (!Number.isFinite(longEdge) || longEdge < 1) throw new Error('long_edge must be a number of pixels, 1 or more.');
  return longEdge;
}

// The captured files as pictures for one answer. The pictures travel in one answer the run may not make larger than
// rules.max_answer_bytes, so the edge shrinks from the one asked for until they fit; the exact sizes in the answer are those
// of the pictures sent. Null when they do not fit even at rules.least_long_edge.
function fitted(names, longEdge, commands, folder) {
  const shrunk = edge => names.map((file, at) => {
    const out = join(folder, `small-${at + 1}.${rules.format}`);
    commands.shrink(file, out, edge, rules.format);
    return { ...commands.size(out), media_type: MEDIA[rules.format], base64: readFileSync(out).toString('base64') };
  });
  let edge = longEdge, pictures = shrunk(edge);
  while (answerBytes(pictures) > rules.max_answer_bytes && edge > rules.least_long_edge) {
    edge = Math.max(rules.least_long_edge, Math.floor(edge * rules.shrink_by));
    pictures = shrunk(edge);
  }
  return answerBytes(pictures) > rules.max_answer_bytes ? null : pictures;
}

// Runs `work` in a folder of this call, removed before it returns whatever happened; a refusal by the system is said in words.
function inAFolder(tmp, work) {
  const folder = mkdtempSync(join(tmp, 'look-at-screen-'));
  try {
    return work(folder);
  } catch (error) {
    if (REFUSED.test(String(error.stderr ?? error.message))) return { needs_access: 'screen-recording', said: rules.words.needs_access };
    return { error: String(error.message).slice(0, 400) };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function look(input, commands, { tmp = tmpdir() } = {}) {
  const longEdge = askedEdge(input);
  return inAFolder(tmp, folder => {
    const { displays, allowed } = commands.screens();
    if (!allowed) return { needs_access: 'screen-recording', said: rules.words.needs_access };
    const names = Array.from({ length: Math.max(1, displays) }, (_, at) => join(folder, `display-${at + 1}.png`));
    commands.capture(names, input?.cursor === true);
    const pictures = fitted(names, longEdge, commands, folder);
    if (!pictures) return { error: rules.words.too_many_displays };
    return { looked_at: new Date().toISOString(), pictures: pictures.map((picture, at) => ({ display: at + 1, main: at === 0, ...picture })), said: rules.words.done };
  });
}

// The frontmost on-screen window of the app named `owner_name` (the name the window server lists for its process), captured by
// the window's own id. An app with no ordinary window on screen is said in words, and nothing is captured.
export function lookAtWindow(input, commands, { tmp = tmpdir() } = {}) {
  const longEdge = askedEdge(input);
  const owner = input?.owner_name;
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('owner_name is the name of the app whose window is pictured, as this Mac lists it.');
  return inAFolder(tmp, folder => {
    const { allowed, windows } = commands.windows(owner);
    if (!allowed) return { needs_access: 'screen-recording', said: rules.words.needs_access };
    const front = windows.find(window => window.layer === 0);
    if (!front) return { no_window: owner, said: rules.words.no_window };
    const file = join(folder, 'window.png');
    commands.captureWindow(front.id, file);
    const [picture] = fitted([file], longEdge, commands, folder) ?? [];
    if (!picture) return { error: rules.words.too_large };
    return { looked_at: new Date().toISOString(), window: { id: front.id, name: front.name, owner }, picture, said: rules.words.window_done };
  });
}

export const lookAtScreen = input => look(input, systemCommands);
export const pictureAnAppWindow = input => lookAtWindow(input, systemCommands);
