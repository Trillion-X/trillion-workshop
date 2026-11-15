// tools/record-the-screen/do-work/capture-session.mjs
//
// Purpose
//   Records the screen on this Mac as a helper process: one chosen display or window, a capturer picked from DATA rows in
//   fallback order, pause/resume/stop sent to it by the verbs its row gives, an editable list of apps and windows to leave
//   out, the app's own windows hidden from the picture (capture-shield.mjs beside this file) unless the person turns that off, the
//   pointer noted beside the recording (positions and presses only) for whatever later reads it, and a save that moves the
//   finished recording to a place the person's allow-list names. `captureTools.capture` is the one tool (action: start,
//   pause, resume, stop, status, save, prefs, exclude).
//
// Non-negotiable invariants
//   1. Which capturers exist, their order, command lines, verbs, the places recordings may go and every word are DATA
//      (tools/record-the-screen/read-data/capture-session.json); this file knows no program. The person's choices are their own file.
//   2. A recording needs a source the person named; none, or one that is not there, is refused. It ends by itself when
//      that source goes away, and says so.
//   3. A capturer that cannot do what was asked (the kind of source, leaving out what was listed, a verb) is skipped or
//      refused in words; nothing is pretended. A capturer that fails to start hands over to the next one.
//   4. The recording is written inside a fresh 0700 folder as a 0600 file; `save` is the only way out, onto a real path
//      under the allow-list, never through a link, never over a file that exists.
//   5. The pointer is noted as normalised-source samples, dropped when outside the source, dropped while paused, and no key
//      is ever noted.
//
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { constants, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withShield } from './capture-shield.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const captureSettings = () => JSON.parse(readFileSync(path.join(HERE, '../read-data/capture-session.json'), 'utf8'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(`${file}.part`, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 }); renameSync(`${file}.part`, file); };
const inside = (place, root) => place === root || place.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** A point in global screen points as a point of the source frame (0-1 each way), or null when it is outside the frame. */
export function normalisePoint(frame, point) {
  if (!frame?.width || !frame?.height) return null;
  const x = (point.x - frame.x) / frame.width; const y = (point.y - frame.y) / frame.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x: Math.round(x * 1e5) / 1e5, y: Math.round(y * 1e5) / 1e5 };
}

/** The person's settings: DATA defaults under their own file. */
export function prefsOf(settings, home = os.homedir()) {
  const mine = readJson(expand(settings.prefs_file, home)) ?? {};
  return { ...settings.defaults, ...mine, exclude: { ...settings.defaults.exclude, ...(mine.exclude ?? {}) }, overrides: { ...settings.defaults.overrides, ...(mine.overrides ?? {}) } };
}

/** The first capturer that can do this recording (or why none can). `has(row)` says whether its program is here. */
export function chooseCapturer(settings, { kind, leaveOut, pin, has }) {
  const reasons = [];
  const ordered = pin ? [...settings.capturers.filter(row => row.id === pin), ...settings.capturers.filter(row => row.id !== pin)] : settings.capturers;
  const eligible = [];
  for (const row of ordered) {
    if (!has(row)) continue;
    if (!row.kinds.includes(kind)) { reasons.push(fill(settings.words.why_kind, { id: row.id, kind })); continue; }
    if (leaveOut.length && !row.leaves_out) { reasons.push(fill(settings.words.why_leaves_out, { id: row.id, list: leaveOut.join(', ') })); continue; }
    eligible.push(row);
  }
  return { eligible, why: reasons.length ? reasons.join('; ') : settings.words.why_none_have };
}

const linesOf = (stream, onLine) => {
  let rest = '';
  stream?.on('data', chunk => { rest += chunk; let at; while ((at = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, at).trim(); rest = rest.slice(at + 1); if (line) onLine(line); } });
};
const jsonLine = line => { try { return JSON.parse(line); } catch { return null; } };

/** The displays and windows on this Mac now: { displays: [{ id, x, y, width, height }], windows: [{ id, app, title, x, y, width, height }] }. */
const listSourcesHere = settings => new Promise((resolve, reject) => {
  execFile(settings.sources.program, [path.join(HERE, settings.sources.script)], { timeout: settings.sources.timeout_ms, maxBuffer: 4_000_000 }, (error, out) => {
    if (error) return reject(error);
    try { resolve(JSON.parse(out)); } catch (parse) { reject(parse); }
  });
});

/** One capture session owner over the programs that touch the Mac, so tests hold pretend ones. */
export function makeCaptureSession({ settings = captureSettings(), home = os.homedir(), now = () => Date.now(), spawn = nodeSpawn,
  sources = () => listSourcesHere(settings), has = row => existsSync(row.program), shield = hold => withShield(hold),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), watch = true } = {}) {
  let current = null; let last = null;
  const statusFile = expand(settings.status_file, home);
  const words = settings.words;

  const publicView = session => session && ({ id: session.id, state: session.state, capturer: session.capturer.id, source: session.source, file: session.file, started_at: session.startedAt, ended_at: session.endedAt ?? null, reason: session.reason ?? null, pointer_samples: session.samples.length });
  const remember = () => writeJson(statusFile, publicView(current ?? last) ?? { state: 'idle' });

  const send = (session, verb) => {
    const how = session.capturer.verbs?.[verb];
    if (!how) throw fail(fill(words.cannot, { id: session.capturer.id, verb }), 409);
    if (how.stdin !== undefined) session.child.stdin.write(how.stdin); else session.child.kill(how.signal);
  };

  const finish = (session, reason) => {
    if (session.state === 'ended') return;
    clearInterval(session.timer);
    session.state = 'ended'; session.reason = reason; session.endedAt = now();
    session.pointerChild?.kill('SIGTERM');
    if (existsSync(session.file)) { try { chmodSync(session.file, 0o600); } catch { /* the file was moved */ } }
    if (session.pointer) writeJson(`${session.file}.pointer.json`, { space: settings.pointer.space, source: session.source, samples: session.samples });
    last = session; current = null; remember(); session.finished();
  };

  const startPointer = session => {
    const config = settings.pointer;
    session.pointerChild = spawn(config.program, [path.join(HERE, config.script), String(config.hz)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let down = false; let place = null;
    linesOf(session.pointerChild.stdout, line => {
      const sample = jsonLine(line);
      // The pause guard: nothing is noted while paused, and presses are never counted from a moment that was not recorded.
      if (!sample || session.state !== 'recording' || !session.frame) return;
      const point = normalisePoint(session.frame, sample);
      const t = Math.max(0, now() - session.startedAt - session.pausedMs);
      if (!point) { down = sample.down === true; return; }
      if (sample.down === true && !down) session.samples.push({ t, type: 'click', ...point });
      else if (!place || Math.hypot(point.x - place.x, point.y - place.y) >= config.least_move) session.samples.push({ t, type: 'move', ...point });
      place = point; down = sample.down === true;
    });
    session.pointerChild.on('error', () => {});
  };

  /** Look at the source again: it moves (the frame follows) or goes away (the recording ends, in words). */
  const tick = async () => {
    const session = current; if (!session || session.state === 'ended') return;
    let list; try { list = await sources(); } catch { return; }
    const row = (list[settings.source_kinds[session.source.kind].list] ?? []).find(item => String(item.id) === String(session.source.id));
    if (!row) { try { send(session, 'stop'); } catch { session.child.kill('SIGTERM'); } finish(session, fill(words.source_gone, { kind: session.source.kind })); return; }
    session.frame = { x: row.x, y: row.y, width: row.width, height: row.height };
  };

  const launch = async (capturer, session, config) => {
    const args = capturer.args.map(arg => fill(arg, {
      script: capturer.script ? path.join(HERE, capturer.script) : '', config: JSON.stringify(config), file: session.file,
      source_flag: fill(capturer.source_flags?.[config.source.kind] ?? '', { number: config.source.id }),
    }));
    const child = spawn(capturer.program, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    session.child = child; session.capturer = capturer;
    let exited = false;
    const ready = new Promise((resolve, reject) => {
      const early = why => reject(new Error(why));
      child.on('error', error => early(String(error?.message ?? error)));
      child.on('exit', code => { exited = true; if (session.state === 'starting') early(`it ended with code ${code}`); else finish(session, session.reason ?? 'the recording program ended'); });
      linesOf(child.stdout, line => {
        const event = jsonLine(line);
        if (event?.event === capturer.handshake) resolve();
        if (event?.event === 'ended') finish(session, event.reason ?? 'the recording program ended');
        if (event?.event === 'failed') early(String(event.why ?? 'it failed'));
      });
      if (!capturer.handshake) wait(capturer.settle_ms ?? 500).then(() => { if (!exited) resolve(); });
      else wait(settings.start_ms).then(() => early('it did not say it was recording'));
    });
    await ready;
  };

  async function start(request = {}) {
    if (current) throw fail(fill(words.busy, { id: current.id }), 409);
    const kinds = Object.keys(settings.source_kinds);
    const source = request.source;
    if (!source || !kinds.includes(source.kind) || source.id === undefined || source.id === '') throw fail(fill(words.source_required, { kinds: kinds.join(' or ') }));
    const prefs = prefsOf(settings, home);
    const list = await sources();
    const row = (list[settings.source_kinds[source.kind].list] ?? []).find(item => String(item.id) === String(source.id));
    if (!row) throw fail(fill(words.source_unknown, { kind: source.kind, id: source.id }), 404);
    const override = prefs.overrides[row.app] ?? {};
    const leaveOut = [...prefs.exclude.apps, ...prefs.exclude.titles];
    const { eligible, why } = chooseCapturer(settings, { kind: source.kind, leaveOut, pin: request.capturer ?? override.capturer, has });
    if (!eligible.length) throw fail(fill(words.no_capturer, { why }), 409);

    const id = `rec-${now().toString(36)}`;
    mkdirSync(expand(settings.work_dir, home), { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(expand(settings.work_dir, home), 'rec-'));
    chmodSync(dir, 0o700);
    const session = { id, state: 'starting', source: { kind: source.kind, id: source.id }, frame: { x: row.x, y: row.y, width: row.width, height: row.height }, file: path.join(dir, 'recording.mov'),
      startedAt: now(), pausedMs: 0, pausedAt: null, samples: [], pointer: prefs.pointer === true, finished: () => {} };
    const done = new Promise(resolve => { session.finished = resolve; }); session.done = done;
    const config = { source: { kind: session.source.kind, id: String(session.source.id), frame: session.frame }, file: session.file, fps: Number(override.fps ?? request.fps ?? prefs.fps), exclude: prefs.exclude };

    const failures = [];
    for (const capturer of eligible) {
      try { await launch(capturer, session, config); failures.length = 0; break; }
      catch (error) { failures.push(fill(words.start_failed, { id: capturer.id, why: error.message })); try { session.child?.kill('SIGKILL'); } catch { /* gone */ } }
    }
    if (failures.length) { rmSync(dir, { recursive: true, force: true }); throw fail(failures.join(' '), 503); }

    session.state = 'recording'; session.startedAt = now(); current = session;
    if (session.pointer) startPointer(session);
    if (prefs.hide_own_windows) shield(() => done).catch(() => {});
    if (watch) { session.timer = setInterval(() => { tick(); }, settings.watch_ms); session.timer.unref?.(); }
    remember();
    return publicView(session);
  }

  const toggle = (verb, from, to) => async () => {
    const session = current; if (!session) throw fail(words.not_running, 409);
    if (session.state !== from) throw fail(fill(words.cannot, { id: session.capturer.id, verb }), 409);
    send(session, verb);
    if (to === 'paused') session.pausedAt = now(); else { session.pausedMs += now() - session.pausedAt; session.pausedAt = null; }
    session.state = to === 'paused' ? 'paused' : 'recording';
    remember(); return publicView(session);
  };
  const pause = toggle('pause', 'recording', 'paused');
  const resume = toggle('resume', 'paused', 'recording');

  async function stop() {
    const session = current; if (!session) throw fail(words.not_running, 409);
    session.reason = 'stopped';
    try { send(session, 'stop'); } catch { session.child.kill('SIGTERM'); }
    const giveUp = wait(settings.stop_ms).then(() => { session.child.kill('SIGKILL'); finish(session, 'it did not stop in time and was ended'); });
    await Promise.race([session.done, giveUp]);
    finish(session, 'stopped');
    return publicView(last);
  }

  /** Moves the finished recording (and its pointer sidecar) to a place the allow-list names. */
  function save({ destination, name } = {}) {
    const session = last; if (!session || !existsSync(session.file)) throw fail(words.nothing_to_save, 404);
    const roots = settings.save.allowed_roots.map(root => expand(root, home));
    const refused = settings.save.refused_roots.map(root => expand(root, home));
    const stamp = new Date(session.startedAt).toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const wanted = destination ? expand(destination, home) : path.join(expand(settings.save.default_folder, home), `${name ?? fill(settings.save.default_name, { stamp })}.mov`);
    const target = path.resolve(wanted);
    const extension = path.extname(target).toLowerCase();
    if (!settings.save.extensions.includes(extension)) throw fail(fill(words.save_extension, { extensions: settings.save.extensions.join(', ') }));
    if (refused.some(root => inside(target, root))) throw fail(fill(words.save_refused, { place: target }), 403);
    if (!roots.some(root => inside(target, root))) throw fail(fill(words.save_outside, { place: target, roots: roots.join(', ') }), 403);
    // The folder is made only under an allowed root, then judged by where it really is, so a link inside it cannot lead out.
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const real = path.join(realpathSync(path.dirname(target)), path.basename(target));
    const realRoots = roots.map(root => { try { return realpathSync(root); } catch { return root; } });
    if (refused.some(root => inside(real, root)) || !realRoots.some(root => inside(real, root))) throw fail(fill(words.save_outside, { place: real, roots: roots.join(', ') }), 403);
    let existing = null; try { existing = lstatSync(real); } catch { /* free */ }
    if (existing?.isSymbolicLink()) throw fail(fill(words.save_link, { place: real }), 403);
    if (existing) throw fail(fill(words.save_exists, { place: real }), 409);
    const move = (from, to) => {
      try { renameSync(from, to); } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        copyFileSync(from, to, constants.COPYFILE_EXCL); chmodSync(to, 0o600); unlinkSync(from);
      }
    };
    move(session.file, real);
    const sidecar = `${session.file}.pointer.json`; let pointer = null;
    if (existsSync(sidecar)) { pointer = `${real}.pointer.json`; move(sidecar, pointer); }
    rmSync(path.dirname(session.file), { recursive: true, force: true });
    last = { ...session, file: real };
    remember();
    return { saved: real, pointer, bytes: statSync(real).size };
  }

  /** The person's own settings: a known name set to a value, or the leave-out list and per-app overrides edited. */
  function prefs(change = {}) {
    const file = expand(settings.prefs_file, home); const mine = readJson(file) ?? {};
    if (change.name !== undefined) {
      if (!Object.hasOwn(settings.defaults, change.name) || ['exclude', 'overrides'].includes(change.name)) throw fail(fill(words.pref_unknown, { name: change.name, names: Object.keys(settings.defaults).filter(key => !['exclude', 'overrides'].includes(key)).join(', ') }));
      writeJson(file, { ...mine, [change.name]: change.value });
    }
    return prefsOf(settings, home);
  }
  function exclude({ what, value, on = true } = {}) {
    const list = { app: 'apps', title: 'titles' }[what];
    if (!list) throw fail(words.exclude_what);
    const file = expand(settings.prefs_file, home); const mine = readJson(file) ?? {};
    const have = new Set(mine.exclude?.[list] ?? prefsOf(settings, home).exclude[list]);
    if (value !== undefined) { if (on === false) have.delete(value); else have.add(value); }
    writeJson(file, { ...mine, exclude: { ...(mine.exclude ?? {}), [list]: [...have] } });
    return prefsOf(settings, home).exclude;
  }

  return { start, pause, resume, stop, save, prefs, exclude, tick, status: () => publicView(current ?? last) ?? { state: 'idle' } };
}

let shared = null;
const sharedSession = () => (shared ??= makeCaptureSession());

export const captureTools = {
  /** { action: start | pause | resume | stop | status | save | prefs | exclude, source?, capturer?, fps?, destination?, name?, what?, value?, on? } */
  async capture(input = {}) {
    const session = sharedSession();
    switch (input.action ?? 'status') {
      case 'start': return session.start(input);
      case 'pause': return session.pause();
      case 'resume': return session.resume();
      case 'stop': return session.stop();
      case 'save': return session.save(input);
      case 'prefs': return session.prefs(input);
      case 'exclude': return { exclude: session.exclude(input) };
      default: return session.status();
    }
  },
};

/** The same tool as one function, the shape tools/records-door's run-an-export.mjs calls. */
export const capture = input => captureTools.capture(input);
