import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/check-a-computer-from-inside/do-work/check-from-inside.mjs
//
// tool:check-a-computer-from-inside: how full each disk of one computer is, and whether each engine its row runs holds a
// person, read over SSH as the computer's administrator from another computer. Input { name, address, runs, row_read_at,
// engine_program?, host_key, admin_user?, ssh_port?, warn_used_pct?, alert_used_pct?, hold_again?, pretend? }; answer { name, address,
// checked, checked_at, row_read_at, units_asked, disks: [{mount, type, size_bytes, used_bytes, available_bytes, used_pct}], engines: [{unit, user, owners, persons,
// listens: [{listen, answered, persons, draining}], held_again?, person_folders: [{person, bytes, largest: [{path, bytes}]}]}],
// findings: [{computer, at, kind, level, about, said,
// pretend?}] }.
//
// The engines are read from the computer's own row (`runs.units`): a unit is an engine when it declares an engine's ready
// check, a loopback listen address (its slots' health_listen, its own health_listen or settings.listen) and a persons
// folder (settings.persons), whatever program it runs. An engine that runs inside a container answers only on that
// container's own network: its unit names `ready_in_container` (the container's name, or {compose_project, service} to
// find it by its compose labels, which outlive a recreated or renamed container), and its ready check is asked inside that container's
// network namespace (nsenter -n with the container's process), with the computer's own curl. The persons its
// settings.local_agents name are the persons it must hold. An engine that answers 0 persons while its row names one is
// held again (unless hold_again is false): engine.add_person_path with {"person": ...} on the engine's own agent socket,
// as the engine's own user, the one road the engine takes a person on; then it is read again. Each person folder in the
// engine's settings.persons folder is measured (du) with its settings.json persons.largest_files largest files, so a
// caller can keep its size each run and see what grows. Every other unit the row runs (a service, a timer, a path) is read
// from systemd (its LoadState, ActiveState and Result): a unit whose last run did not end in success (a base backup that
// failed) is unit-failed, a timer or path that is not active is unit-not-running, and a unit the computer does not have is
// unit-missing. A unit that runs in slots is read as its engine, not here. Everything else only reads.
// What is checked is only what `runs.units` names, so a runs with no units list, a call that does not say when the row was read
// (`row_read_at`), or a row read longer ago than settings.json row.max_age_seconds, is not checked: it would answer a computer green, or name
// as missing a unit the row has since dropped (Nov 25 2026: a copy of a row read 44 minutes earlier named five units
// another apply had removed, and a call with no units checked none and answered no finding).
// The wake book of each engine that names a local agent is read too: wake:list on its agent socket, as the administrator
// the SSH login is (the socket admits a caller by its OS user, and the row's local agent is root), page by page (`after`).
// An engine's due-time wakes need a teller on that same computer (a wake of settings.json wakes.teller_tool whose id is
// one of wakes.teller_ids or starts with a wakes.teller_prefix, switched on and standing), or no occurrence of theirs is
// ever told: Nov 25 2026, 6:40 AM CST, the Elestio engine held a due-time wake with no teller and a 6:45 school tick was
// missed with nothing said. Such an engine is `due-time-wakes-without-a-teller`; a book that could not be read (the socket
// refused the caller, a page did not answer, the answer was no list) is its own finding, `wake-book-not-read`, and never
// read as "no due-time wakes". An engine whose row names no local agent holds no one (a meeting point) and is not read.
// `pretend` replaces what was read ({disks: {mount: used_pct}, engines: {unit: persons}, units: {unit: result},
// wake_books: {unit: [wake, ...] | {refused: why}}, unreachable: true}) so a caller
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
import { dueTimesNotTold, notToldFinding, readOwnDueTimeWakes, routerSilence, routerSilenceFinding } from './due-times-told.mjs';
import { administrationArguments, checkedHost, heldKeyFile, knownHostsLine } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const MARK = '@@';

// Every value written into a remote command is one of these shapes, or the command is not made.
const LISTEN = /^127\.0\.0\.1:[0-9]{1,5}$/;
const UNIT = /^[A-Za-z0-9@._-]{1,128}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SOCKET = /^\/[A-Za-z0-9._/-]{1,200}$/;
const PERSON = /^[A-Za-z0-9_-]{1,128}$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A unit's `ready_in_container`: a container's name, or the compose project and service whose container it is
 *  ({compose_project, service}); null for none, or for one outside its shape (never written into a command). */
export function containerOf(given) {
  if (typeof given === 'string') return CONTAINER.test(given) ? { name: given } : null;
  if (given && typeof given === 'object' && CONTAINER.test(given.compose_project ?? '') && CONTAINER.test(given.service ?? '')) return { compose_project: given.compose_project, service: given.service };
  return null;
}

/** The shell words that print the process id of an engine's container, for nsenter. */
function containerPid(container) {
  const found = container.name ? `'${container.name}'`
    : `"$(docker ps -q --filter 'label=com.docker.compose.project=${container.compose_project}' --filter 'label=com.docker.compose.service=${container.service}' | head -1)"`;
  return `"$(docker inspect -f '{{.State.Pid}}' ${found} 2>/dev/null)"`;
}

const unique = values => [...new Set(values)];

/** The engines a computer row's `runs` names, each a unit that declares a ready check (a loopback listen address and a
 *  persons folder): [{unit, user, listens, persons_folder, container, socket, owners}]. */
export function enginesOf(runs) {
  const units = Array.isArray(runs?.units) ? runs.units : [];
  return units.filter(unit => unit && typeof unit.settings?.persons === 'string').map(unit => {
    const slots = unit.slots && typeof unit.slots === 'object' ? Object.values(unit.slots) : [];
    const listens = slots.length
      ? slots.map(slot => slot?.health_listen ?? slot?.['settings.listen'])
      : [unit.health_listen ?? unit.settings?.listen];
    const agents = Array.isArray(unit.settings?.local_agents) ? unit.settings.local_agents : [];
    return {
      unit: unit.unit,
      user: unit.user,
      listens: unique(listens.filter(listen => typeof listen === 'string' && LISTEN.test(listen))),
      persons_folder: typeof unit.settings?.persons === 'string' && SOCKET.test(unit.settings.persons) ? unit.settings.persons.replace(/\/+$/, '') : null,
      container: containerOf(unit.ready_in_container),
      socket: typeof unit.settings?.agent_socket === 'string' && SOCKET.test(unit.settings.agent_socket) ? unit.settings.agent_socket : null,
      owners: unique(agents.map(agent => agent?.person).filter(person => typeof person === 'string' && PERSON.test(person))),
    };
  }).filter(engine => typeof engine.unit === 'string' && UNIT.test(engine.unit) && engine.persons_folder && engine.listens.length);
}

/** The units of a computer row systemd is asked about: every unit name the row runs, except one run in slots (each slot
 *  is its own unit, read as an engine). */
export function unitsOf(runs) {
  const units = Array.isArray(runs?.units) ? runs.units : [];
  return unique(units.filter(unit => unit && !(unit.slots && typeof unit.slots === 'object')).map(unit => unit.unit)
    .filter(name => typeof name === 'string' && UNIT.test(name)));
}

/** The one shell script that reads every disk, every engine's ready answer and what systemd says of each unit, each part
 *  after its own mark line. */
export function readScript(engines, units = []) {
  const seconds = Number(SETTINGS.engine.ask_seconds);
  const lines = [`echo '${MARK}df'`, 'df -P -T -B1 2>/dev/null'];
  engines.forEach((engine, index) => engine.listens.forEach(listen => {
    if (!LISTEN.test(listen)) throw new Error(`An engine's listen address was refused: ${listen}.`);
    // An engine in a container is asked on that container's network: enter it by the container's process, keep this curl.
    if (engine.container && containerOf(engine.container.name ?? engine.container) === null) throw new Error('An engine\'s container was refused.');
    const inside = engine.container ? `nsenter -t ${containerPid(engine.container)} -n ` : '';
    lines.push(`echo '${MARK}ready ${index} ${listen}'`, `${inside}curl -s -m ${seconds} http://${listen}${SETTINGS.engine.ready_path}; echo`);
  }));
  const largest = Number(SETTINGS.persons.largest_files);
  engines.forEach((engine, index) => {
    if (!engine.persons_folder) return;
    if (!SOCKET.test(engine.persons_folder)) throw new Error(`An engine's persons folder was refused: ${engine.persons_folder}.`);
    // Each person's folder: one `folder <person> <bytes>` line, then its largest files as `file <person> <bytes> <path>`.
    lines.push(`echo '${MARK}persons ${index}'`,
      `for d in ${engine.persons_folder}/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); echo "folder $n $(du -sb "$d" 2>/dev/null | cut -f1)"; find "$d" -xdev -type f -printf '%s %P\\n' 2>/dev/null | sort -nr | head -${largest} | sed "s#^#file $n #"; done`);
  });
  lines.push(`echo '${MARK}units'`);
  for (const unit of units) {
    if (!UNIT.test(unit)) throw new Error(`A unit name was refused: ${unit}.`);
    lines.push(`echo 'unit ${unit}'`, `systemctl show -p LoadState -p ActiveState -p Result '${unit}' 2>/dev/null`);
  }
  lines.push(`echo '${MARK}end'`);
  return `${lines.join('\n')}\n`;
}

/** The script that holds `person` again at `engine`: the add on its agent socket as its own user, then the status code. */
export function holdAgainScript(engine, person) {
  if (!USER.test(engine.user ?? '') || !SOCKET.test(engine.socket ?? '') || !PERSON.test(person ?? '')) throw new Error(`The engine ${engine.unit} cannot be asked to hold a person: its row names no usable user, agent socket or person.`);
  const body = JSON.stringify({ person });
  return `runuser -u ${engine.user} -- curl -s -m ${Number(SETTINGS.engine.ask_seconds) * 2} -o /dev/null -w '%{http_code}\\n' --unix-socket ${engine.socket} -X POST -H 'content-type: application/json' --data '${body}' http://engine${SETTINGS.engine.add_person_path}\n`;
}

// A cursor is the id of the last wake of the page: letters, digits, a few marks, and the unit separator (U+001F) between its parts
// (read live Nov 25 2026, 7:39 AM CST); JSON writes that one as \u001f, so nothing but plain text reaches the shell.
const CURSOR = /^[A-Za-z0-9:_./#@+=\u001f-]{1,512}$/;

/** The script that asks one page of an engine's wake book (wake:list) on its agent socket. The door answers a call only at a
 *  Host it admits (a loopback name, settings.json wakes.host; any other is refused `host_not_admitted`, read live Nov 25 2026, 7:35 AM CST
 *  when this asked as `engine`). `after` is the cursor the last page named (null for the first page). */
export function wakeListScript(engine, after, requestKey) {
  if (!SOCKET.test(engine.socket ?? '')) throw new Error(`The engine ${engine.unit} cannot be asked for its wakes: its row names no usable agent socket.`);
  if (after !== null && !CURSOR.test(after)) throw new Error('A wake list cursor was refused.');
  if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(requestKey)) throw new Error('A request key was refused.');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
    arguments: { method: 'wake:list', request_key: requestKey, input: after === null ? {} : { after } } } });
  return `curl -s -m ${Number(SETTINGS.wakes.ask_seconds)} --unix-socket ${engine.socket} -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18' --data '${body}' http://${SETTINGS.wakes.host}${SETTINGS.wakes.mcp_path}; echo\n`;
}

/** One wake list page as the door answered it (plain JSON or an event stream): { wakes, next } or { why }. */
export function parseWakePage(stdout) {
  const text = String(stdout).trim();
  if (text === '') return { why: 'the agent socket gave no answer' };
  const json = text.startsWith('{') ? text : text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
  let answer;
  try { answer = JSON.parse(json); } catch { return { why: `the agent socket's answer was not JSON: ${text.slice(0, 120)}` }; }
  const said = value => JSON.stringify(value).slice(0, SETTINGS.wakes.most_refusal_chars);
  if (answer?.error) return { why: `the door refused: ${answer.error.message ?? answer.error.code ?? said(answer.error)}` };
  const result = answer?.result;
  let content = result?.structuredContent;
  if (!content && typeof result?.content?.[0]?.text === 'string') { try { content = JSON.parse(result.content[0].text); } catch { content = null; } }
  // A refusal that names no detail or code is told as the door gave it (bounded), so its cause is read, never guessed.
  if (result?.isError) return { why: `the door refused: ${content?.detail ?? content?.code ?? said(result)}` };
  if (!Array.isArray(content?.wakes)) return { why: 'the door answered no list of wakes' };
  return { wakes: content.wakes, switch_history: Array.isArray(content.switch_history) ? content.switch_history : [], next: typeof content.next === 'string' && content.next !== '' ? content.next : null };
}

/** The whole wake book of one engine, every page: { wakes } or { why } when any page was not read. `now` makes the request keys. */
export function readWakeBook(engine, run, now = Date.now()) {
  const wakes = [];
  const seen = new Set();
  let history = [];
  let after = null;
  for (let page = 0; page < Number(SETTINGS.wakes.most_pages); page += 1) {
    let asked;
    try { asked = run(wakeListScript(engine, after, `wakes:${now.toString(36)}:${page}`)); } catch (error) { return { why: error.message }; }
    if (asked.status !== 0) return { why: `${(asked.stderr || `exit ${asked.status}`).trim().split('\n').at(-1)}` };
    const read = parseWakePage(asked.stdout);
    if (read.why) return { why: read.why };
    wakes.push(...read.wakes);
    if (page === 0) history = read.switch_history;
    if (read.next === null) return { wakes, switch_history: history };
    if (seen.has(read.next)) return { why: 'the wake list named the same next page twice' };
    seen.add(read.next);
    after = read.next;
  }
  return { why: `the wake list has more than ${SETTINGS.wakes.most_pages} pages` };
}

const standing = wake => wake?.switched_on === true && wake?.switch_stands === true;

/** What a wake book holds of due-time wakes and tellers: { due_time_wakes: [id], tellers: [id] }, only wakes switched on that stand. */
export function tellersIn(wakes) {
  const { teller_tool: tool, teller_ids: ids, teller_prefix: prefix } = SETTINGS.wakes;
  const isTeller = wake => wake.tool === tool && typeof wake.id === 'string' && (ids.includes(wake.id) || wake.id.startsWith(prefix));
  return {
    due_time_wakes: wakes.filter(wake => standing(wake) && wake?.on?.fact?.kind === SETTINGS.wakes.kind).map(wake => wake.id),
    tellers: wakes.filter(wake => standing(wake) && isTeller(wake)).map(wake => wake.id),
  };
}

/** What one read script printed: { disks, ready: [{index, listen, answer}] }. */
export function parseRead(stdout) {
  const disks = [];
  const ready = [];
  const folders = [];
  const units = [];
  const skip = new Set(SETTINGS.disk.skip_types);
  let part = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith(MARK)) {
      const [kind, index, listen] = line.slice(MARK.length).split(' ');
      part = kind === 'ready' ? { index: Number(index), listen, lines: [] } : kind === 'persons' ? { persons: Number(index) } : kind;
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
    } else if (part === 'units') {
      const named = line.match(/^unit (\S+)$/);
      const field = line.match(/^(LoadState|ActiveState|Result)=(.*)$/);
      if (named) units.push({ unit: named[1], load: null, active: null, result: null });
      else if (field && units.length) units.at(-1)[{ LoadState: 'load', ActiveState: 'active', Result: 'result' }[field[1]]] = field[2].trim();
    } else if (part && typeof part === 'object' && 'persons' in part) {
      const folder = line.match(/^folder ([A-Za-z0-9_-]+) ([0-9]+)$/);
      const file = line.match(/^file ([A-Za-z0-9_-]+) ([0-9]+) (.+)$/);
      if (folder) folders.push({ index: part.persons, person: folder[1], bytes: Number(folder[2]), largest: [] });
      else if (file) folders.findLast(item => item.index === part.persons && item.person === file[1])?.largest.push({ path: file[3], bytes: Number(file[2]) });
    } else if (part && typeof part === 'object') part.lines.push(line);
  }
  return { disks, folders, units, ready: ready.map(({ index, listen, lines }) => ({ index, listen, answer: lines.join('\n').trim() })) };
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
export function findingsOf({ disks, engines, units = [] }, { warn, alert, pretended = new Set() }) {
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
  for (const unit of units) {
    const pretend = pretended.has(`unit:${unit.unit}`) ? { pretend: true } : {};
    if (unit.load === 'not-found') {
      findings.push({ kind: 'unit-missing', level: 'warn', about: unit.unit, said: `${unit.unit} is in this computer's row, but the computer has no such unit.`, ...pretend });
    } else if (unit.result && unit.result !== 'success') {
      findings.push({ kind: 'unit-failed', level: 'alert', about: unit.unit, said: `${unit.unit} last ended in ${unit.result}, not success (it is ${unit.active ?? 'in an unknown state'} now); its journal says why.`, ...pretend });
    } else if (/\.(timer|path)$/.test(unit.unit) && unit.load === 'loaded' && unit.active !== 'active') {
      findings.push({ kind: 'unit-not-running', level: 'alert', about: unit.unit, said: `${unit.unit} is ${unit.active ?? 'in an unknown state'}, so what it starts no longer runs.`, ...pretend });
    }
  }
  return findings;
}

/** The findings of the wake books read: [{kind, level, about, said, pretend?}]. `books` are [{unit, wakes?|why?, switch_history?, pretend?}]; `nowMs`
 *  is when they were read. An engine with no teller is told as that; one whose due-time wakes were not told when due (a teller on but
 *  stuck or broken, or none) is `due-time-not-told` (due-times-told.mjs), unless the missing teller already says why. */
export function wakeBookFindings(books, nowMs = Date.now()) {
  const findings = [];
  for (const book of books) {
    const pretend = book.pretend ? { pretend: true } : {};
    if (book.why !== undefined) {
      findings.push({ kind: 'wake-book-not-read', level: 'warn', about: book.unit, said: `The wakes of ${book.unit} could not be read: ${book.why}. So whether its due-time wakes have a teller is not known.`, ...pretend });
      continue;
    }
    const silence = routerSilenceFinding(book.unit, routerSilence(book.wakes, nowMs));
    if (silence) findings.push({ ...silence, ...pretend });
    const held = tellersIn(book.wakes);
    if (held.due_time_wakes.length === 0 || held.tellers.length > 0) {
      const symptom = notToldFinding(book.unit, dueTimesNotTold(book.wakes, book.switch_history, nowMs).late);
      if (symptom) findings.push({ ...symptom, ...pretend });
      continue;
    }
    const shown = held.due_time_wakes.slice(0, SETTINGS.wakes.most_named);
    const more = held.due_time_wakes.length - shown.length;
    findings.push({ kind: 'due-time-wakes-without-a-teller', level: 'alert', about: book.unit,
      said: `${book.unit} has ${held.due_time_wakes.length} switched-on due-time wake${held.due_time_wakes.length === 1 ? '' : 's'} (${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}) but no switched-on ${SETTINGS.wakes.teller_tool} wake named ${SETTINGS.wakes.teller_ids.join(' or ')} or ${SETTINGS.wakes.teller_prefix}<name>, so nothing tells them when they are due.`, ...pretend });
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

/** The computer this run is on, read through the run's own door (no SSH): each due-time wake told when it was due. The strict check of a
 *  teller cannot be made here (a run's right lists only the wakes that hear a kind of fact, never the tellers, which hear nothing), so the
 *  symptom is the check: `due-time-not-told`. `options.door` stands in for the descriptor on fd 3 and `options.fetchImpl` for fetch (tests). */
export async function checkHere(input, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const base = { name: input?.name ?? null, address: null, checked_at: checkedAt };
  const notChecked = why => ({ ...base, checked: false, why, disks: [], engines: [], units: [], wake_books: [], findings: [] });
  let door = options.door;
  if (!door) {
    try { door = JSON.parse(readFileSync(3, 'utf8')); } catch (error) { return notChecked(`this run was handed no door on fd 3: ${error.message}`); }
  }
  if (typeof door?.url !== 'string' || typeof door?.capability !== 'string') return notChecked('this run was handed no door on fd 3.');
  const pretended = input?.pretend?.wake_books;
  const read = pretended !== undefined && !Array.isArray(pretended) && typeof pretended === 'object' && 'here' in pretended
    ? (Array.isArray(pretended.here) ? { computer: input?.name ?? 'this-computer', wakes: pretended.here, switch_history: input.pretend.switch_history?.here ?? [] } : { why: String(pretended.here?.refused ?? 'pretended refusal') })
    : await readOwnDueTimeWakes(door, { fetchImpl: options.fetchImpl, ...(options.kinds ? { kinds: options.kinds } : {}) });
  const name = read.computer ?? input?.name ?? 'this-computer';
  const pretend = pretended?.here !== undefined ? { pretend: true } : {};
  const judged = read.why === undefined ? dueTimesNotTold(read.wakes, read.switch_history, nowMs) : null;
  const finding = read.why !== undefined
    ? { kind: 'wake-book-not-read', level: 'warn', about: 'this-computer', said: `The due-time wakes of this computer could not be read through its own door: ${read.why}.`, ...pretend }
    : notToldFinding('this-computer', judged.late);
  const silence = read.why === undefined ? routerSilenceFinding('this-computer', routerSilence(read.wakes, nowMs)) : null;
  const book = read.why !== undefined ? { unit: 'this-computer', read: false, why: read.why }
    : { unit: 'this-computer', read: true, due_time_wakes: tellersIn(read.wakes).due_time_wakes, not_told: [...new Set(judged.late.map(item => item.wake))], not_judged: judged.not_judged };
  return { ...base, name, checked: true, disks: [], engines: [], units: [], wake_books: [{ ...book, ...pretend }],
    findings: [finding, silence].filter(Boolean).map(item => ({ computer: name, at: checkedAt, ...item, ...pretend })) };
}

/** Read one computer from inside. `options.run` stands in for SSH (a test); `options.keyFile` is the administrator key. */
export async function checkFromInside(input, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  if (input?.here === true) return checkHere(input, { ...options, nowMs });
  const name = input?.name ?? input?.address;
  const checkedAt = new Date(nowMs).toISOString();
  const named = findings => findings.map(finding => ({ computer: name, at: checkedAt, ...finding }));
  const base = { name, address: input?.address ?? null, checked_at: checkedAt };
  let host;
  try {
    host = checkedHost({ address: input?.address, ssh_port: input?.ssh_port ?? SETTINGS.ssh.port, admin_user: input?.admin_user ?? SETTINGS.ssh.admin_user, host_key: input?.host_key });
    knownHostsLine(host);
  } catch (error) {
    return { ...base, checked: false, why: error.message, disks: [], engines: [], findings: [] };
  }
  const notChecked = why => ({ ...base, checked: false, why, disks: [], engines: [], findings: [] });
  if (!Array.isArray(input.runs?.units)) return notChecked('runs.units was not given: pass the computer row\'s runs as read now (an empty list for a computer that runs no unit); with no units list nothing on the computer can be checked.');
  const rowReadAt = input.row_read_at ?? null;
  if (rowReadAt === null) return notChecked('row_read_at was not given: pass the time the computer row was read, in the same read as its runs, so a row read long ago is never checked as if it were now.');
  {
    const age = (Date.parse(checkedAt) - Date.parse(rowReadAt)) / 1000;
    const most = Number(SETTINGS.row.max_age_seconds);
    if (!Number.isFinite(age)) return notChecked(`row_read_at was refused: give the time the row was read as an ISO time, not ${JSON.stringify(rowReadAt)}.`);
    if (age > most) return notChecked(`the computer row was read ${Math.round(age)} s before this check, more than ${most} s: read the row again and pass its runs, so a unit it has since added or dropped is not misread.`);
    if (age < -60) return notChecked(`row_read_at ${rowReadAt} is after this check began: give the time the row was read.`);
  }
  base.row_read_at = rowReadAt;
  base.units_asked = unitsOf(input.runs);
  const warn = Number(input.warn_used_pct ?? SETTINGS.disk.warn_used_pct);
  const alert = Number(input.alert_used_pct ?? SETTINGS.disk.alert_used_pct);
  if (!(warn > 0 && alert >= warn && alert <= 100)) throw new Error('warn_used_pct and alert_used_pct were refused: give 0 < warn <= alert <= 100.');
  const run = options.run ?? sshRunner(host, options.keyFile);
  const pretend = input.pretend && typeof input.pretend === 'object' ? input.pretend : {};
  const engines = enginesOf(input.runs);
  const read = pretend.unreachable ? { status: 255, stdout: '', stderr: 'pretended: no answer' } : run(readScript(engines, unitsOf(input.runs)));
  if (read.status !== 0 || !read.stdout.includes(`${MARK}end`)) {
    const said = `${name} could not be read over SSH: ${(read.stderr || `exit ${read.status}`).trim().split('\n').at(-1)}.`;
    return { ...base, checked: false, why: said, disks: [], engines: [],
      findings: named([{ kind: 'unreachable', level: 'alert', about: host.address, said, ...(pretend.unreachable ? { pretend: true } : {}) }]) };
  }
  const { disks, ready, folders, units } = parseRead(read.stdout);
  const pretended = new Set();
  for (const [name, result] of Object.entries(pretend.units ?? {})) {
    const unit = units.find(item => item.unit === name);
    if (unit && typeof result === 'string') { unit.result = result; pretended.add(`unit:${name}`); }
  }
  for (const [mount, used] of Object.entries(pretend.disks ?? {})) {
    const disk = disks.find(item => item.mount === mount);
    if (disk && Number.isFinite(Number(used))) { const room = disk.used_bytes + disk.available_bytes; disk.used_pct = Number(used); disk.used_bytes = Math.round(room * Number(used) / 100); disk.available_bytes = room - disk.used_bytes; pretended.add(`disk:${mount}`); }
  }
  const asRead = enginesAsRead(engines, ready);
  asRead.forEach((engine, index) => {
    if (engines[index].persons_folder) engine.person_folders = folders.filter(item => item.index === index).map(({ person, bytes, largest }) => ({ person, bytes, largest }));
  });
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
  // The wake book of each engine that names a local agent (an engine whose row names none holds no one and has no book to read).
  const books = [];
  if (input.read_wake_books !== false) {
    for (const engine of engines.filter(item => item.owners.length > 0)) {
      const pretended = pretend.wake_books?.[engine.unit];
      if (pretended !== undefined) {
        books.push(Array.isArray(pretended) ? { unit: engine.unit, wakes: pretended, switch_history: pretend.switch_history?.[engine.unit] ?? [], pretend: true } : { unit: engine.unit, why: String(pretended?.refused ?? 'pretended refusal'), pretend: true });
        continue;
      }
      books.push({ unit: engine.unit, ...readWakeBook(engine, run, nowMs) });
    }
  }
  const wakeBooks = books.map(book => ({ unit: book.unit, read: book.why === undefined, ...(book.why === undefined ? tellersIn(book.wakes) : { why: book.why }), ...(book.pretend ? { pretend: true } : {}) }));
  return { ...base, checked: true, disks, engines: asRead, units, wake_books: wakeBooks,
    findings: named([...findingsOf({ disks, engines: asRead, units }, { warn, alert, pretended }), ...wakeBookFindings(books, nowMs)]) };
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
