// tools/look-at-screen/do-work/look-at-screen.mjs
//
// The Workshop tool "Look at my screen": a picture of what is on the person's Mac screen right now, for their AI to
// see. Every display is captured, the main one first, each labelled with its exact pixel size so an AI can point at a
// spot. Run as a function by tools/records-door/do-work/run-an-export.mjs on the person's own Mac.
//
// Invariants:
// - It looks only when run; nothing is captured in the background.
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

// The commands this tool runs, each one call; a test hands in stand-ins.
export const systemCommands = {
  screens: () => JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ASK_THE_SYSTEM], { encoding: 'utf8' })),
  // -x: no sound; -C: the pointer too. One file name per display, the main display first.
  capture: (files, cursor) => { execFileSync('/usr/sbin/screencapture', ['-x', ...(cursor ? ['-C'] : []), ...files]); },
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

export function look(input, commands, { tmp = tmpdir() } = {}) {
  if (input !== null && typeof input !== 'object') throw new Error('The request must be an object; it may carry long_edge and cursor.');
  const longEdge = Math.min(input?.long_edge ?? rules.long_edge, rules.long_edge);
  if (!Number.isFinite(longEdge) || longEdge < 1) throw new Error('long_edge must be a number of pixels, 1 or more.');
  const folder = mkdtempSync(join(tmp, 'look-at-screen-'));
  try {
    const { displays, allowed } = commands.screens();
    if (!allowed) return { needs_access: 'screen-recording', said: rules.words.needs_access };
    const names = Array.from({ length: Math.max(1, displays) }, (_, at) => join(folder, `display-${at + 1}.png`));
    commands.capture(names, input?.cursor === true);
    const shrunk = edge => names.map((file, at) => {
      const out = join(folder, `small-${at + 1}.${rules.format}`);
      commands.shrink(file, out, edge, rules.format);
      return { display: at + 1, main: at === 0, ...commands.size(out), media_type: MEDIA[rules.format], base64: readFileSync(out).toString('base64') };
    });
    // The pictures travel in one answer the run may not make larger than rules.max_answer_bytes, so the edge shrinks
    // from the one asked for until they fit; the exact sizes in the answer are those of the pictures sent.
    let edge = longEdge, pictures = shrunk(edge);
    while (answerBytes(pictures) > rules.max_answer_bytes && edge > rules.least_long_edge) {
      edge = Math.max(rules.least_long_edge, Math.floor(edge * rules.shrink_by));
      pictures = shrunk(edge);
    }
    if (answerBytes(pictures) > rules.max_answer_bytes) return { error: rules.words.too_many_displays };
    return { looked_at: new Date().toISOString(), pictures, said: rules.words.done };
  } catch (error) {
    if (REFUSED.test(String(error.stderr ?? error.message))) return { needs_access: 'screen-recording', said: rules.words.needs_access };
    return { error: String(error.message).slice(0, 400) };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export const lookAtScreen = input => look(input, systemCommands);
