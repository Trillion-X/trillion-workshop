// tools/check-every-screen-at-every-width/window-picture.mjs
//
// PURPOSE
//   A picture of the window an app shows on this Mac, as the person sees it: the window the owner has on screen with the
//   widest area (the app's main window), taken by screencapture with the window's own id. Nothing is clicked, typed or
//   raised; the window is only read. The picture is kept through the same keep path as the live pages' pictures.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Passive. The window is captured by its id (screencapture -l); no focus, click, key or move is sent to it.
//   2. A capture that the window server or Screen Recording refuses is answered with that reason and the tool's own stderr
//      first line, never a guessed picture.
//   3. The temporary file is made in an empty folder of this call and removed after the bytes are read.
//
// SHAPE
//   windowPicture({ owner, name, keep }) -> { window: { id, name, width, height }, picture, picture_kept, ... } | { error, reason }
//     owner  the process name the window server lists (e.g. "Trillion")
//     name   the Files name the picture is kept under when keep is given
//     keep   (name, bytes) -> { picture, picture_kept, ... } (the live pages' keepPicture)
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
// The Mac's own Python with the Quartz bindings the window server is read through (the same interpreter the held-database
// reader uses, called by its absolute path so no PATH is trusted).
const PYTHON = '/opt/homebrew/anaconda3/bin/python3';
const SCREENCAPTURE = '/usr/sbin/screencapture';

function refuse(error, reason) {
  return Object.assign(new Error(reason), { code: error });
}

// The first line of a tool's stderr, short and free of anything but its words.
const firstLine = error => String(error?.stderr ?? error?.message ?? error).split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? 'no output';

// The on-screen windows of the owner, widest first; the app's main window is the first (layer 0 is a normal window).
export async function windowsOf(owner, { exec = run } = {}) {
  let out;
  try {
    ({ stdout: out } = await exec(PYTHON, ['-I', join(here, 'list-windows.py'), owner], { timeout: 20000, killSignal: 'SIGKILL' }));
  } catch (error) {
    throw refuse('window_list_failed', `The window server did not list ${owner}'s windows: ${firstLine(error)}`);
  }
  return JSON.parse(out).filter(window => window.onscreen && window.layer === 0).sort((a, b) => b.width * b.height - a.width * a.height);
}

export async function windowPicture({ owner = 'Trillion', name = `/live-screens/window-${owner.toLowerCase()}.png`, keep }, { exec = run } = {}) {
  if (typeof owner !== 'string' || !owner) throw refuse('refused', 'owner is the process name the window server lists.');
  const [main] = await windowsOf(owner, { exec });
  if (!main) return { error: 'no_window', reason: `${owner} has no window on screen.` };
  const folder = await mkdtemp(join(tmpdir(), 'live-window-'));
  const file = join(folder, 'window.png');
  try {
    try {
      await exec(SCREENCAPTURE, ['-x', '-o', '-l', String(main.id), file], { timeout: 20000, killSignal: 'SIGKILL' });
    } catch (error) {
      return { error: 'capture_refused', reason: firstLine(error), window: { id: main.id, name: main.name, width: main.width, height: main.height } };
    }
    const bytes = await readFile(file);
    const window = { id: main.id, name: main.name, width: main.width, height: main.height };
    if (typeof keep !== 'function') return { window, picture: null, picture_kept: false, reason: 'no_keep', bytes_length: bytes.length };
    return { window, ...(await keep(name, bytes)) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
