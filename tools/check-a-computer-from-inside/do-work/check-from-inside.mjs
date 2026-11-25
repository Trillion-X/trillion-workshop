import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/check-a-computer-from-inside/do-work/check-from-inside.mjs
//
// tool:check-a-computer-from-inside: how full each disk of one computer is, and whether each engine its row runs holds a
// person, read over SSH as the computer's administrator from another computer. Input { name, address, runs,
// engine_program, host_key, admin_user?, ssh_port?, warn_used_pct?, alert_used_pct?, hold_again?, pretend? }; answer { name, address,
// checked, checked_at, disks: [{mount, type, size_bytes, used_bytes, available_bytes, used_pct}], engines: [{unit, user, owners, persons,
// listens: [{listen, answered, persons, draining}], held_again?}], findings: [{computer, at, kind, level, about, said,
// pretend?}] }.
//
// The engines are read from the computer's own row (`runs.units`): a unit whose `program` is the input's engine_program
// is an engine, its slots' (or its own) health_listen are where it answers engine.ready_path, and the persons its
// settings.local_agents name are the persons it must hold. An engine that answers 0 persons while its row names one is
// held again (unless hold_again is false): engine.add_person_path with {"person": ...} on the engine's own agent socket,
// as the engine's own user, the one road the engine takes a person on; then it is read again. Everything else only reads.
// `pretend` replaces what was read ({disks: {mount: used_pct}, engines: {unit: persons}, unreachable: true}) so a caller
// can see the findings of a full disk, an empty engine or a lost computer without making one; a pretended empty engine is
// never held again, and each finding it makes says pretend: true.
//
// The administrator key is the file named by the first argument (the run's mount of the held key), the host key is pinned
// from the input, and the connection goes through the run's own proxy (HTTPS_PROXY), as tools/administer-a-rented-host
// makes it. What counts as a finding is settings.json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { administrationArguments, checkedHost, heldKeyFile, knownHostsLine } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const MARK = '@@';

// Every value written into a remote command is one of these shapes, or the command is not made.
const LISTEN = /^127\.0\.0\.1:[0-9]{1,5}$/;
const UNIT = /^[A-Za-z0-9@._-]{1,128}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SOCKET = /^\/[A-Za-z0-9._/-]{1,200}$/;
const PERSON = /^[A-Za-z0-9_-]{1,128}$/;

const unique = values => [...new Set(values)];

/** The engines a computer row's `runs` names, each a unit running `program`: [{unit, user, listens, socket, owners}]. */
export function enginesOf(runs, program) {
  const units = Array.isArray(runs?.units) ? runs.units : [];
  return units.filter(unit => unit && typeof program === 'string' && program && unit.program === program).map(unit => {
    const slots = unit.slots && typeof unit.slots === 'object' ? Object.values(unit.slots) : [];
    const listens = slots.length
      ? slots.map(slot => slot?.health_listen ?? slot?.['settings.listen'])
      : [unit.health_listen ?? unit.settings?.listen];
    const agents = Array.isArray(unit.settings?.local_agents) ? unit.settings.local_agents : [];
    return {
      unit: unit.unit,
      user: unit.user,
      listens: unique(listens.filter(listen => typeof listen === 'string' && LISTEN.test(listen))),
      socket: typeof unit.settings?.agent_socket === 'string' && SOCKET.test(unit.settings.agent_socket) ? unit.settings.agent_socket : null,
      owners: unique(agents.map(agent => agent?.person).filter(person => typeof person === 'string' && PERSON.test(person))),
    };
  }).filter(engine => typeof engine.unit === 'string' && UNIT.test(engine.unit));
}

/** The one shell script that reads every disk and every engine's ready answer, each part after its own mark line. */
export function readScript(engines) {
  const seconds = Number(SETTINGS.engine.ask_seconds);
  const lines = [`echo '${MARK}df'`, 'df -P -T -B1 2>/dev/null'];
  engines.forEach((engine, index) => engine.listens.forEach(listen => {
    if (!LISTEN.test(listen)) throw new Error(`An engine's listen address was refused: ${listen}.`);
    lines.push(`echo '${MARK}ready ${index} ${listen}'`, `curl -s -m ${seconds} http://${listen}${SETTINGS.engine.ready_path}; echo`);
  }));
  lines.push(`echo '${MARK}end'`);
  return `${lines.join('\n')}\n`;
}

/** The script that holds `person` again at `engine`: the add on its agent socket as its own user, then the status code. */
export function holdAgainScript(engine, person) {
  if (!USER.test(engine.user ?? '') || !SOCKET.test(engine.socket ?? '') || !PERSON.test(person ?? '')) throw new Error(`The engine ${engine.unit} cannot be asked to hold a person: its row names no usable user, agent socket or person.`);
  const body = JSON.stringify({ person });
  return `runuser -u ${engine.user} -- curl -s -m ${Number(SETTINGS.engine.ask_seconds) * 2} -o /dev/null -w '%{http_code}\\n' --unix-socket ${engine.socket} -X POST -H 'content-type: application/json' --data '${body}' http://engine${SETTINGS.engine.add_person_path}\n`;
}

/** What one read script printed: { disks, ready: [{index, listen, answer}] }. */
export function parseRead(stdout) {
  const disks = [];
  const ready = [];
  const skip = new Set(SETTINGS.disk.skip_types);
  let part = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith(MARK)) {
      const [kind, index, listen] = line.slice(MARK.length).split(' ');
      part = kind === 'ready' ? { index: Number(index), listen, lines: [] } : kind;
      if (kind === 'ready') ready.push(part);
      continue;
    }
    if (part === 'df') {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 7 || !/^[0-9]+$/.test(fields[2])) continue;
      const [, type, size, used, available] = fields;
      const mount = fields.slice(6).join(' ');
      if (skip.has(type)) continue;
      const usedBytes = Number(used);
      const room = usedBytes + Number(available);
      disks.push({ mount, type, size_bytes: Number(size), used_bytes: usedBytes, available_bytes: Number(available), used_pct: room > 0 ? Math.round((usedBytes / room) * 1000) / 10 : 0 });
    } else if (part && typeof part === 'object') part.lines.push(line);
  }
  return { disks, ready: ready.map(({ index, listen, lines }) => ({ index, listen, answer: lines.join('\n').trim() })) };
}

const readyOf = answer => {
  try { const ready = JSON.parse(answer); return Number.isInteger(ready?.persons) ? ready : null; } catch { return null; }
};

/** Each engine as it answered: listens that answered, and the most persons any of them holds (null when none answered). */
export function enginesAsRead(engines, ready) {
  return engines.map((engine, index) => {
    const listens = engine.listens.map(listen => {
      const answer = readyOf(ready.find(item => item.index === index && item.listen === listen)?.answer ?? '');
      return { listen, answered: answer !== null, persons: answer?.persons ?? null, draining: answer?.draining ?? null };
    });
    const answered = listens.filter(listen => listen.answered);
    return { unit: engine.unit, user: engine.user, owners: engine.owners, listens, persons: answered.length ? Math.max(...answered.map(listen => listen.persons)) : null };
  });
}

/** The findings of what was read, by the thresholds: [{kind, level, about, said, pretend?}]. */
export function findingsOf({ disks, engines }, { warn, alert, pretended = new Set() }) {
  const findings = [];
  for (const disk of disks) {
    const level = disk.used_pct >= alert ? 'alert' : disk.used_pct >= warn ? 'warn' : null;
    if (!level) continue;
    findings.push({ kind: level === 'alert' ? 'disk-nearly-full' : 'disk-filling', level, about: disk.mount,
      said: `${disk.mount} is ${disk.used_pct}% full (${level === 'alert' ? `at or past ${alert}%` : `at or past ${warn}%`}); ${(disk.available_bytes / 1e9).toFixed(1)} GB free of ${Math.round(disk.size_bytes / 1e9)} GB.`,
      ...(pretended.has(`disk:${disk.mount}`) ? { pretend: true } : {}) });
  }
  for (const engine of engines) {
    const pretend = pretended.has(`engine:${engine.unit}`) ? { pretend: true } : {};
    if (!engine.listens.length) continue;
    if (engine.persons === null) {
      findings.push({ kind: 'engine-not-answering', level: 'alert', about: engine.unit, said: `${engine.unit} did not answer its ready check at ${engine.listens.map(listen => listen.listen).join(' or ')}.`, ...pretend });
      continue;
    }
    // An engine held again is told even when it holds its person now: it lost them, and its signed-in calls were refused.
    const held = engine.held_again;
    if (held === undefined && (engine.persons > 0 || !engine.owners.length)) continue;
    const level = held?.persons > 0 ? 'warn' : 'alert';
    const what = held === undefined ? 'It was not held again (hold_again is false).'
      : held.pretend ? 'It would be held again on its own agent socket; a pretended engine is not asked.'
      : held.persons > 0 ? `It was held again on its own agent socket (answered ${held.status}) and now holds ${held.persons}.`
      : `Holding it again failed (answered ${held.status ?? 'nothing'}${held.error ? `: ${held.error}` : ''}); it still holds none, so every signed-in call to it is refused.`;
    findings.push({ kind: 'engine-held-no-person', level, about: engine.unit, said: `${engine.unit} held no person, though its row names ${engine.owners.length === 1 ? 'one' : engine.owners.length}. ${what}`, ...pretend });
  }
  return findings;
}

/** One remote script run over SSH: { status, stdout, stderr }. */
function sshRunner(host, keyFile) {
  return script => {
    const folder = mkdtempSync(join(tmpdir(), 'inside-'));
    try {
      const knownHostsFile = join(folder, 'known_hosts');
      writeFileSync(knownHostsFile, knownHostsLine(host), { mode: 0o600 });
      const args = administrationArguments({ ...host, adminKeyFile: heldKeyFile(keyFile), knownHostsFile, proxy: process.env.HTTPS_PROXY || null });
      const run = spawnSync('ssh', [...args, 'sh -s'], { input: script, encoding: 'utf8', timeout: Number(SETTINGS.ssh.run_seconds) * 1000 });
      return { status: run.status, stdout: run.stdout ?? '', stderr: (run.stderr ?? '') + (run.error ? String(run.error.message) : '') };
    } finally { rmSync(folder, { recursive: true, force: true }); }
  };
}

/** Read one computer from inside. `options.run` stands in for SSH (a test); `options.keyFile` is the administrator key. */
export async function checkFromInside(input, options = {}) {
  const name = input?.name ?? input?.address;
  const checkedAt = new Date().toISOString();
  const named = findings => findings.map(finding => ({ computer: name, at: checkedAt, ...finding }));
  const base = { name, address: input?.address ?? null, checked_at: checkedAt };
  let host;
  try {
    host = checkedHost({ address: input?.address, ssh_port: input?.ssh_port ?? SETTINGS.ssh.port, admin_user: input?.admin_user ?? SETTINGS.ssh.admin_user, host_key: input?.host_key });
    knownHostsLine(host);
  } catch (error) {
    return { ...base, checked: false, why: error.message, disks: [], engines: [], findings: [] };
  }
  const warn = Number(input.warn_used_pct ?? SETTINGS.disk.warn_used_pct);
  const alert = Number(input.alert_used_pct ?? SETTINGS.disk.alert_used_pct);
  if (!(warn > 0 && alert >= warn && alert <= 100)) throw new Error('warn_used_pct and alert_used_pct were refused: give 0 < warn <= alert <= 100.');
  const run = options.run ?? sshRunner(host, options.keyFile);
  const pretend = input.pretend && typeof input.pretend === 'object' ? input.pretend : {};
  const engines = enginesOf(input.runs, input.engine_program);
  const read = pretend.unreachable ? { status: 255, stdout: '', stderr: 'pretended: no answer' } : run(readScript(engines));
  if (read.status !== 0 || !read.stdout.includes(`${MARK}end`)) {
    const said = `${name} could not be read over SSH: ${(read.stderr || `exit ${read.status}`).trim().split('\n').at(-1)}.`;
    return { ...base, checked: false, why: said, disks: [], engines: [],
      findings: named([{ kind: 'unreachable', level: 'alert', about: host.address, said, ...(pretend.unreachable ? { pretend: true } : {}) }]) };
  }
  const { disks, ready } = parseRead(read.stdout);
  const pretended = new Set();
  for (const [mount, used] of Object.entries(pretend.disks ?? {})) {
    const disk = disks.find(item => item.mount === mount);
    if (disk && Number.isFinite(Number(used))) { const room = disk.used_bytes + disk.available_bytes; disk.used_pct = Number(used); disk.used_bytes = Math.round(room * Number(used) / 100); disk.available_bytes = room - disk.used_bytes; pretended.add(`disk:${mount}`); }
  }
  const asRead = enginesAsRead(engines, ready);
  for (const [unit, persons] of Object.entries(pretend.engines ?? {})) {
    const engine = asRead.find(item => item.unit === unit);
    if (engine && Number.isInteger(persons)) { engine.persons = persons; engine.listens.forEach(listen => { if (listen.answered) listen.persons = persons; }); pretended.add(`engine:${unit}`); }
  }
  for (const [index, engine] of asRead.entries()) {
    if (engine.persons !== 0 || !engine.owners.length || input.hold_again === false) continue;
    if (pretended.has(`engine:${engine.unit}`)) { engine.held_again = { pretend: true }; continue; }
    const given = engines[index];
    try {
      const asked = run(holdAgainScript(given, given.owners[0]));
      const status = asked.stdout.trim().split('\n').at(-1) || null;
      const again = run(readScript([given]));
      const now = again.status === 0 ? enginesAsRead([given], parseRead(again.stdout).ready)[0] : null;
      engine.held_again = { person: given.owners[0], status, persons: now?.persons ?? null };
      if (now?.persons > 0) { engine.persons = now.persons; engine.listens = now.listens; }
    } catch (error) { engine.held_again = { person: given.owners[0], status: null, persons: null, error: error.message }; }
  }
  return { ...base, checked: true, disks, engines: asRead, findings: named(findingsOf({ disks, engines: asRead }, { warn, alert, pretended })) };
}

const startedAsProgram = (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]));
if (startedAsProgram) {
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    console.log(JSON.stringify({ result: await checkFromInside(input, { keyFile: process.argv[2] }) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
