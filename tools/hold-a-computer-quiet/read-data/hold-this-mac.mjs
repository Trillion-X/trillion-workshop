// computer/hold-this-mac.mjs
//
// PURPOSE
//   Holds this Mac quiet for a session: the apps a hold names are asked to quit whenever they open (or, when a hold
//   names `only`, every app but those and the always-open ones), and Focus is on, until the hold's own end time. Four Workshop tools on placement:your-computer (computer/mac-tools.json): hold, release,
//   holds and focus. A protocol step (a lock-in session, a bedtime schedule, any rule) runs them by tool id; nothing here
//   knows what a session is.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A hold always ends by itself: its `until` is required and never more than `longest_hours` away, and the watcher
//      drops it at that time even if nobody releases it, so a hold can never keep the person out of their own Mac.
//   2. Apps in `always_open`, and every app a `keep_open_rows` row of computer/computer-sources.json names (the apps the
//      person's AIs run in, found by kind, never typed here), are never closed, whatever a hold names. An app is known by
//      every identity it has (its shown name, its bundle's file name, its executable, its bundle id, its bundle path), so
//      an app whose shown name differs from its executable (super.engineering runs as superconductor) is still known.
//   6. An app using a resource in `spare_while_using` (the microphone: a live recording or call) is never closed while it
//      uses it, read from the Mac's own power assertions (coreaudiod names the process each audio-in assertion is for);
//      the app is closed on a later look, once the recording or call ends.
//   3. Holds live in one file under the person's home; a missing or unreadable file means nothing is held (it fails
//      open, never closed). After the helper restarts, `resumeHolds` reads it and keeps watching what still lasts.
//   4. An app is asked to quit the polite way first (so it can ask to save); only when that is refused is it ended.
//   5. Which apps, which Focus shortcut, how often to look and every word said are DATA (computer/hold-this-mac.json).
//
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const holdSettings = () => JSON.parse(readFileSync(join(HERE, 'hold-this-mac.json'), 'utf8'));
/** The rows of the file `keep_open_rows.from` names (computer/computer-sources.json `sources`). */
export const placeRows = settings => JSON.parse(readFileSync(join(HERE, settings.keep_open_rows.from), 'utf8')).sources ?? [];
/** The rows whose apps no hold closes: any `keep_open_rows.where` test ({ field, equals }) holds. */
export const keptRows = (settings, rows = []) => rows.filter(row => (settings.keep_open_rows?.where ?? []).some(test => row[test.field] === test.equals));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const run = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || error?.message || '') }));
});

/** The end of a hold from its input: an ISO time, or minutes from now, capped at longest_hours. → { until, capped } */
export function untilOf({ until, minutes } = {}, settings, now = Date.now()) {
  const asked = typeof until === 'string' && Number.isFinite(Date.parse(until)) ? Date.parse(until)
    : Number.isFinite(minutes) && minutes > 0 ? now + minutes * 60_000 : null;
  if (asked === null || asked <= now) return null;
  const latest = now + settings.longest_hours * 3_600_000;
  return { until: new Date(Math.min(asked, latest)).toISOString(), capped: asked > latest };
}

/** An installed app bundle's own names from its Info.plist: { executable, bundle_id }, or {} when it is not on this Mac. */
export function bundleFacts(path) {
  const key = name => { try { return execFileSync('plutil', ['-extract', name, 'raw', '-o', '-', join(path, 'Contents/Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  return { executable: key('CFBundleExecutable'), bundle_id: key('CFBundleIdentifier') };
}

/** The identities no hold closes: always_open names, plus each `keep_open_rows` row's app bundles (their paths, file
 *  names, and the executable and bundle id the installed bundle declares) and label. rows are computer-sources places;
 *  home expands a leading ~; facts reads a bundle's names. -> Set of lowercased identities. */
export function keptIdentities(settings, rows = [], home = homedir(), facts = bundleFacts) {
  const kept = new Set(settings.always_open.map(name => name.toLowerCase()));
  for (const row of keptRows(settings, rows)) {
    if (typeof row.label === 'string') kept.add(row.label.toLowerCase());
    for (const path of row.look?.paths ?? []) {
      if (!/\.app$/i.test(path)) continue;
      const full = path.replace(/^~(?=\/)/, home);
      kept.add(full.toLowerCase());
      kept.add(basename(full).replace(/\.app$/i, '').toLowerCase());
      for (const name of Object.values(facts(full))) if (typeof name === 'string' && name) kept.add(name.toLowerCase());
    }
  }
  return kept;
}

/** Every identity a running app has, lowercased: shown name, bundle file name, executable name, bundle id, bundle path. */
export const identitiesOf = app => (typeof app === 'string' ? [app] : [app.name, app.bundle && basename(app.bundle).replace(/\.app$/i, ''), app.executable && basename(app.executable), app.bundle_id, app.bundle])
  .filter(value => typeof value === 'string' && value).map(value => value.toLowerCase());

/** The apps a hold may close: the ones asked for (or the default list), never one kept open. */
export function closableApps(apps, settings, kept = keptIdentities(settings)) {
  const asked = Array.isArray(apps) && apps.length ? apps : settings.default_apps;
  return [...new Set(asked.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))].filter(name => !kept.has(name.toLowerCase()));
}

/** The apps a hold keeps open when it names `only`: those asked for, never empty (an empty list holds nothing). */
export const keptApps = only => (Array.isArray(only) ? [...new Set(only.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))] : []);

/** Whether a running app (or a bare name) is closed by the lasting holds: named by a hold, or not kept by a hold that
 *  names `only`; never one kept open. Every identity of the app is compared. */
export function closedBy(holds, settings, kept = keptIdentities(settings)) {
  const named = new Set(holds.flatMap(hold => hold.apps ?? []).map(name => name.toLowerCase()));
  const onlies = holds.filter(hold => hold.only?.length).map(hold => new Set(hold.only.map(name => name.toLowerCase())));
  return app => {
    const ids = identitiesOf(app);
    if (ids.some(id => kept.has(id))) return false;
    return ids.some(id => named.has(id)) || onlies.some(only => !ids.some(id => only.has(id)));
  };
}

/** The processes using a spared resource, from `pmset -g assertions` text: coreaudiod's assertions each say
 *  `Created for PID: n.` and `Resources: audio-in ...`. -> Set of pids. */
export function pidsUsing(text, resources) {
  const pids = new Set();
  let pid = null;
  for (const line of text.split('\n')) {
    if (/^\s*pid \d+\(/.test(line)) { pid = null; continue; }
    const made = line.match(/Created for PID: (\d+)/);
    if (made) { pid = Number(made[1]); continue; }
    const used = line.match(/Resources: (.*)$/);
    if (used && pid !== null && used[1].split(/\s+/).some(name => resources.includes(name))) pids.add(pid);
  }
  return pids;
}

/** The app pids among `apps` that are, or are an ancestor of, a pid in `using`; parents from `ps -axo pid=,ppid=`. */
export function appsUsing(apps, using, psText) {
  const parent = new Map(psText.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(pair => pair.length === 2 && pair.every(Number.isFinite)));
  const appPids = new Set(apps.map(app => app.pid));
  const spared = new Set();
  for (let pid of using) {
    for (let hops = 0; pid > 1 && hops < 64; hops += 1, pid = parent.get(pid)) {
      if (appPids.has(pid)) { spared.add(pid); break; }
    }
  }
  return spared;
}

/** Holds still lasting at `now`, from the file's rows. */
export const lasting = (holds, now = Date.now()) => holds.filter(hold => Date.parse(hold.until) > now);

/** Running apps (foreground ones) from `lsappinfo list` text → [{ name, pid, bundle_id?, bundle?, executable? }]. */
export function runningApps(text) {
  const apps = [];
  let current = null;
  const facts = { bundleID: 'bundle_id', 'bundle path': 'bundle', 'executable path': 'executable' };
  for (const line of text.split('\n')) {
    const head = line.match(/^\s*\d+\) "(.+)" ASN:/);
    if (head) { current = { name: head[1] }; continue; }
    if (!current) continue;
    const fact = line.match(/^\s*(bundleID|bundle path|executable path)="(.*)"/);
    if (fact) { current[facts[fact[1]]] = fact[2]; continue; }
    const kind = line.match(/pid = (\d+).*type="(\w+)"/);
    if (kind) { if (kind[2] === 'Foreground') apps.push({ ...current, pid: Number(kind[1]) }); current = null; }
  }
  return apps;
}

/** The tools, over a home folder and a command runner, so tests hold a pretend Mac. */
export function makeHolds({ settings = holdSettings(), rows = placeRows(settings), home = homedir(), facts = bundleFacts, exec = run, now = () => Date.now(), timers = { setInterval, clearInterval } } = {}) {
  const folder = join(home, settings.folder);
  const kept = keptIdentities(settings, rows, home, facts);
  const keptNames = [...new Set([...settings.always_open, ...keptRows(settings, rows).map(row => row.label)])];
  const file = join(folder, 'holds.json');
  let watching = null;

  async function read() {
    try { const value = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(value.holds) ? value.holds : []; }
    catch { return []; }
  }
  async function write(holds) {
    await mkdir(folder, { recursive: true });
    const next = `${file}.next`;
    await writeFile(next, JSON.stringify({ holds }, null, 2));
    await rename(next, file);
  }

  async function switchFocus(on) {
    const name = on ? settings.focus.on : settings.focus.off;
    const listed = await exec('shortcuts', ['list']);
    if (!listed.stdout.split('\n').includes(name)) {
      // Not on this Mac yet: sign the shortcut from DATA and open it, so the person adds it with one press.
      await mkdir(folder, { recursive: true });
      const plain = join(folder, `${name}.json`);
      const unsigned = join(folder, `${name}.unsigned.shortcut`);
      const signed = join(folder, `${name}.shortcut`);
      await writeFile(plain, JSON.stringify(settings.focus.shortcuts[name]));
      await exec('plutil', ['-convert', 'binary1', '-o', unsigned, plain]);
      await exec('shortcuts', ['sign', '--mode', 'people-who-know-me', '--input', unsigned, '--output', signed]);
      await exec('open', [signed]);
      return { focus: on ? 'on' : 'off', switched: false, needs_person: settings.words.add_shortcut };
    }
    const done = await exec('shortcuts', ['run', name]);
    return done.ok ? { focus: on ? 'on' : 'off', switched: true } : { focus: on ? 'on' : 'off', switched: false, error: fill(settings.words.focus_failed, { error: done.stderr.trim() }) };
  }

  async function quit(app) {
    const polite = await exec('osascript', ['-e', `quit app ${JSON.stringify(app.name)}`]);
    if (!polite.ok) await exec('kill', ['-TERM', String(app.pid)]);
    return app.name;
  }

  // One look: holds that ended are dropped (Focus turned off if no lasting hold wants it), then every named app open is
  // asked to quit.
  async function look() {
    const all = await read();
    const still = lasting(all, now());
    if (still.length !== all.length) {
      await write(still);
      if (all.some(hold => hold.focus) && !still.some(hold => hold.focus)) await switchFocus(false);
    }
    if (!still.length) { stopWatching(); return []; }
    const closes = closedBy(still, settings, kept);
    const open = runningApps((await exec('lsappinfo', ['list'])).stdout).filter(closes);
    if (!open.length) return [];
    // An app on a live recording or call is left for a later look, once it lets the microphone go.
    const using = pidsUsing((await exec('pmset', ['-g', 'assertions'])).stdout, settings.spare_while_using);
    const spared = using.size ? appsUsing(open, using, (await exec('ps', ['-axo', 'pid=,ppid='])).stdout) : new Set();
    return Promise.all(open.filter(app => !spared.has(app.pid)).map(quit));
  }
  function startWatching() {
    if (watching) return;
    watching = timers.setInterval(() => { look().catch(() => {}); }, settings.watch_seconds * 1000);
  }
  function stopWatching() {
    if (!watching) return;
    timers.clearInterval(watching);
    watching = null;
  }

  return {
    look,
    // input: { id?, apps?: [app name], only?: [app name], focus?: boolean, until?: ISO time, minutes?: number }
    async hold(input = {}) {
      const end = untilOf(input, settings, now());
      if (!end) throw Object.assign(new Error(settings.words.until_needed), { status: 400 });
      const only = keptApps(input.only);
      const apps = only.length ? [] : closableApps(input.apps, settings, kept);
      const id = typeof input.id === 'string' && input.id ? input.id : `hold-${now()}`;
      const holds = lasting(await read(), now()).filter(hold => hold.id !== id);
      const hold = { id, apps, ...(only.length ? { only } : {}), focus: input.focus !== false, until: end.until };
      await write([...holds, hold]);
      const focus = hold.focus ? await switchFocus(true) : null;
      startWatching();
      const closed = await look();
      return {
        hold, closed, ...(focus ? { focus } : {}),
        said: fill(only.length ? settings.words.held_only : settings.words.held, { until: end.until, apps: (only.length ? [...new Set([...only, ...keptNames])] : apps).join(', '), focus: hold.focus ? settings.words.focus_on : '' }) + (end.capped ? ` ${fill(settings.words.too_long, { hours: settings.longest_hours, until: end.until })}` : '') + (focus?.needs_person ? ` ${focus.needs_person}` : ''),
      };
    },
    // input: { id?: one hold, or every hold when left out }
    async release(input = {}) {
      const all = lasting(await read(), now());
      const gone = typeof input.id === 'string' && input.id ? all.filter(hold => hold.id === input.id) : all;
      const kept = all.filter(hold => !gone.includes(hold));
      await write(kept);
      const focus = gone.some(hold => hold.focus) && !kept.some(hold => hold.focus) ? await switchFocus(false) : null;
      if (!kept.length) stopWatching();
      if (!gone.length) return { released: [], said: settings.words.nothing_held };
      return { released: gone.map(hold => hold.id), ...(focus ? { focus } : {}), said: fill(settings.words.released, { apps: [...new Set(gone.flatMap(hold => hold.apps))].join(', '), focus: focus ? settings.words.focus_off : '' }) };
    },
    async holds() {
      const all = lasting(await read(), now());
      if (!all.length) return { holds: [], said: settings.words.nothing_held };
      const last = all.map(hold => hold.until).sort().at(-1);
      return { holds: all, said: fill(settings.words.holding, { count: all.length, until: last }) };
    },
    // input: { on: boolean }
    async focus(input = {}) {
      const switched = await switchFocus(input.on !== false);
      return { ...switched, said: switched.needs_person ?? switched.error ?? fill(settings.words.focus_switched, { state: switched.focus }) };
    },
    // After the helper starts: keep watching holds that still last, drop the ones that ended.
    async resume() {
      const all = await read();
      if (!all.length) return;
      if (lasting(all, now()).length) startWatching();
      await look();
    },
  };
}

let shared = null;
const holdsHere = () => (shared ??= makeHolds());

export const holdTools = {
  hold: input => holdsHere().hold(input),
  release: input => holdsHere().release(input),
  holds: () => holdsHere().holds(),
  focus: input => holdsHere().focus(input),
  resume: () => holdsHere().resume(),
};
