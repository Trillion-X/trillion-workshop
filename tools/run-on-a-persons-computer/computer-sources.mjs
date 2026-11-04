// computer/computer-sources.mjs
//
// Purpose: the first time the Trillion app opens on a computer, and on every launch after, it looks for every source
// on that computer by itself (notes, recordings, messages, mail, photos, drives, AI apps, the services its browsers use)
// and tells the person's Trillion account what it found, so Connections shows it without the person connecting
// anything (dev/trillion src/computer-sources.mjs). What each place is and where it lives are rows in
// computer-sources.json (beside this file); a way of checking is a leaf in LOOKS, and a browser's store of sites is a leaf in SITE_READERS.
//
// Invariants:
// - Read only, and never what a place contains: a place is checked by whether it exists and whether this app may open
//   it. From a browser only the sites' host names are read, never a cookie's value, and only the ones that match a
//   service the account already offers leave this computer, as that service's name.
// - A place a `paths` look finds may be asked what it is: `facts` reads the property list it carries about itself (an
//   app's version and name, through macOS's plutil), and its row's `works` rules turn them into words and into the
//   services this computer carries for the person (`carrier`, one card renewed on every look). Never the person's files.
// - Each look runs in a fresh child process, so access the person grants while the app runs is seen on the next look
//   without restarting anything (a running process keeps the access it started with).
// - A place that cannot be opened is reported as needing its switch (its row's `gate`), and the switch's pane and the
//   Connections page are opened once, the first time; nothing else waits on it.
// - The account is told when discovery or reader evidence changes; each report replaces this computer's previous one.
// - The core names no app, place or service: they are rows (computer-sources.json) and the account's own list.
import {readFileSync, writeFileSync, renameSync, readdirSync, statSync, openSync, closeSync, copyFileSync, mkdirSync, rmSync} from 'node:fs';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// `{program}` in a switch's words is the program macOS lists for it: the Trillion app, or the helper's own runtime.
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (hole, key) => values[key] ?? hole);
// Reader errors may contain a local path, item id or remote response body. Send only a small reason category.
const readerReason = value => {
  const words = String(value ?? '');
  if (['working', 'starting', 'needs access'].includes(words)) return words;
  const code = words.match(/\b(?:account answered|HTTP)\s+(\d{3})\b/i)?.[1];
  if (code) return `the account answered ${code}${/media[_ -]?type/i.test(words) ? ' about a media type' : ''}`;
  if (/timed? out/i.test(words)) return 'reader timed out';
  if (/EPERM|EACCES|not permitted|authorization denied/i.test(words)) return 'needs access';
  if (/not signed in|could not be reached|network/i.test(words)) return 'account could not be reached';
  return 'reader failed';
};
const refused = error => /EPERM|EACCES|not permitted|authorization denied|unable to open database/i.test(`${error?.code ?? ''} ${error?.message ?? error}`);

/**
 * The address that opens the pane a switch needs (computer-sources.json `gates`): the Trillion app's own guide, a panel
 * beside System Settings with the app's icon to drag in, when the app runs this program; otherwise the pane itself.
 */
export function accessPaneAddress(gate = 'full-disk-access', {env = process.env, gates = JSON.parse(readFileSync(new URL('./computer-sources.json', import.meta.url), 'utf8')).gates} = {}) {
  const row = gates[gate];
  return env.TRILLION_APP_CHILD && row.guide ? row.guide : row.open;
}

/** `~` and one-segment `*` wildcards in a place, expanded against `home`: every existing path it names. */
export function placesOf(pattern, home) {
  const expanded = pattern.replace(/^~(?=\/|$)/, home);
  let found = [expanded.startsWith('/') ? '/' : ''];
  for (const segment of expanded.split('/').filter(Boolean)) {
    if (!segment.includes('*')) { found = found.map(base => path.join(base, segment)); continue; }
    const matches = new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    found = found.flatMap(base => { try { return readdirSync(base).filter(name => matches.test(name)).map(name => path.join(base, name)); } catch { return []; } });
  }
  return found.filter(place => { try { statSync(place); return true; } catch { return false; } });
}

/** Whether this process may open a place: 'open', 'refused', or null when it is not there. */
function openable(place) {
  try {
    if (statSync(place).isDirectory()) readdirSync(place);
    else closeSync(openSync(place, 'r'));
    return 'open';
  } catch (error) { return refused(error) ? 'refused' : null; }
}

// A browser's store of sites, read to host names only. (file, workdir) -> host names.
export const SITE_READERS = {
  'chromium-cookies': (file, workdir) => sqliteColumn(file, workdir, 'SELECT DISTINCT host_key AS host FROM cookies'),
  'firefox-cookies': (file, workdir) => sqliteColumn(file, workdir, 'SELECT DISTINCT host FROM moz_cookies'),
  // Safari's Cookies.binarycookies: 'cook', page count and sizes (big-endian), then pages of cookies whose domain is a
  // NUL-terminated string at the offset each cookie names (little-endian).
  'safari-cookies': file => {
    const bytes = readFileSync(file);
    if (bytes.toString('latin1', 0, 4) !== 'cook') return [];
    const pages = bytes.readUInt32BE(4);
    let pageStart = 8 + pages * 4;
    const hosts = new Set();
    for (let page = 0; page < pages; page += 1) {
      const size = bytes.readUInt32BE(8 + page * 4);
      const cookies = bytes.readUInt32LE(pageStart + 4);
      for (let index = 0; index < cookies; index += 1) {
        const cookie = pageStart + bytes.readUInt32LE(pageStart + 8 + index * 4);
        const domainAt = cookie + bytes.readUInt32LE(cookie + 16);
        const end = bytes.indexOf(0, domainAt);
        if (end > domainAt) hosts.add(bytes.toString('utf8', domainAt, end));
      }
      pageStart += size;
    }
    return [...hosts];
  },
};

// A browser keeps its store open while it runs, so it is read from a copy in this owner's own work folder, removed after.
function sqliteColumn(file, workdir, query) {
  mkdirSync(workdir, {recursive: true});
  const copy = path.join(workdir, `${randomUUID()}.sqlite`);
  try {
    copyFileSync(file, copy);
    const db = new DatabaseSync(copy, {readOnly: true});
    try { return db.prepare(query).all().map(row => row.host).filter(Boolean); } finally { db.close(); }
  } finally { rmSync(copy, {force: true}); }
}

const matches = (host, domain) => { const bare = host.replace(/^\./, '').toLowerCase(); return bare === domain || bare.endsWith(`.${domain}`); };
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// Ways of checking a place. (row, look, context) -> [found] where found is { id, label, state, detail? }; a place that
// is not there is simply not in the answer.
export const LOOKS = {
  paths(row, places, {home}) {
    for (const place of places.flatMap(pattern => placesOf(pattern, home))) {
      const state = openable(place);
      if (state === 'open' && row.look.facts) return [{id: row.id, label: row.label, state: 'found', ...whatWorks(row, factsOf(place, row.look.facts))}];
      if (state) return [{id: row.id, label: row.label, state: state === 'open' ? 'found' : 'needs_switch'}];
    }
    // A place under a folder this app may not open looks missing; its row's switch is what tells them apart.
    return places.some(pattern => refusedParent(pattern.replace(/^~(?=\/|$)/, home))) ? [{id: row.id, label: row.label, state: 'needs_switch'}] : [];
  },
  entries(row, folder, {home}, look = row.look) {
    const place = folder.replace(/^~(?=\/|$)/, home);
    let names;
    try { names = readdirSync(place).filter(name => !name.startsWith('.') && !(look.skip ?? []).includes(name)); }
    catch (error) { return refused(error) ? [{id: row.id, label: row.label, state: 'needs_switch'}] : []; }
    if (look.names_containing) names = names.filter(name => look.names_containing.some(part => name.includes(part)));
    if (look.each) return names.map(name => ({id: `${row.id}:${name}`, label: name, state: 'found'}));
    return names.length ? [{id: row.id, label: row.label, state: 'found', detail: plural(names.length, look.count_as?.replace(/s$/, '') ?? 'item', look.count_as)}] : [];
  },
  browser_sites(row, stores, {home, domains, workdir}) {
    const sites = new Set();
    let any = false, blocked = false;
    for (const store of stores) {
      for (const file of store.paths.flatMap(pattern => placesOf(pattern, home))) {
        any = true;
        try { for (const host of SITE_READERS[store.reader]?.(file, workdir) ?? []) sites.add(host); }
        catch (error) { if (refused(error)) blocked = true; }
      }
    }
    if (!any) return [];
    // An address several services share (one company's many products) says which company, not which service, so only
    // an address that belongs to one service counts.
    const owners = new Map();
    for (const service of domains) for (const domain of service.domains) owners.set(domain, (owners.get(domain) ?? 0) + 1);
    const used = domains.filter(service => service.domains.some(domain => owners.get(domain) === 1 && [...sites].some(host => matches(host, domain)))).map(service => service.vendor);
    return [{id: row.id, label: row.label, state: blocked && !used.length ? 'needs_switch' : 'found', detail: used.length ? plural(used.length, 'service') : undefined, browser_sites: used}];
  },
};

/**
 * What a found app says about itself: `facts` is { file, keys } where file is under the found place (an app's
 * Contents/Info.plist) and keys maps a fact's name to the key it is read from. `path` is always a fact. A property list
 * is read with macOS's own plutil, so a binary one reads the same as text.
 */
export function factsOf(place, {file, keys = {}}, read = target => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', target], {encoding: 'utf8', timeout: 10_000}))) {
  let list = {};
  try { list = read(path.join(place, file)); } catch {}
  return {path: place, ...Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, typeof list[key] === 'string' ? list[key] : null]))};
}

// '21.1.1' before '21.10': each dotted part compared as a number.
const versionOrder = (left, right) => {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
};
// One test of a rule against the facts: contains (text), at_least / below (a dotted version).
const holds = (test, facts) => {
  const value = facts[test.fact];
  if (value === null || value === undefined) return false;
  if (test.contains !== undefined) return String(value).includes(test.contains);
  if (test.at_least !== undefined) return versionOrder(value, test.at_least) >= 0;
  if (test.below !== undefined) return versionOrder(value, test.below) < 0;
  return false;
};

/**
 * The first of the row's `works` rules whose every test holds says what this copy of the app can do: its `detail`
 * (with {fact} filled in) and whether this computer carries the row's service (`carries`, a service-connections
 * vendor) for the person. No rule holding: the facts alone, carrying nothing.
 */
export function whatWorks(row, facts) {
  const rule = (row.look.works ?? []).find(item => (item.if ?? []).every(test => holds(test, facts)));
  const detail = fill(rule?.detail ?? row.look.detail ?? '', facts).trim();
  return {...(detail ? {detail} : {}), ...(rule?.carries && row.carries ? {carries: row.carries} : {})};
}

function refusedParent(place) {
  for (let parent = path.dirname(place); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    try { readdirSync(parent); return false; } catch (error) { if (refused(error)) return true; }
  }
  return false;
}

/** One look over every row, in this process: { sources: [found], browser_sites: [service] }. */
export function lookHere({rows, home = os.homedir(), domains = [], workdir}) {
  const sources = [], browserSites = new Set();
  for (const row of rows) {
    const [kind, places] = Object.entries(row.look).find(([key]) => Object.hasOwn(LOOKS, key)) ?? [];
    if (!kind) { sources.push({id: row.id, label: row.label, state: 'could_not_check', detail: 'No way of checking it is known here.'}); continue; }
    let found;
    try { found = LOOKS[kind](row, places, {home, domains, workdir}); }
    catch (error) { found = [{id: row.id, label: row.label, state: 'could_not_check', detail: String(error.message ?? error).slice(0, 200)}]; }
    for (const item of found) {
      for (const vendor of item.browser_sites ?? []) browserSites.add(vendor);
      sources.push({id: item.id, label: item.label, category: row.category, state: item.state, ...(item.detail ? {detail: item.detail} : {}), ...(item.state === 'needs_switch' && row.gate ? {gate: row.gate} : {}), ...(item.carries ? {carries: item.carries} : {})});
    }
  }
  return {sources, browser_sites: [...browserSites]};
}

/**
 * The same look in fresh child processes (see the invariants), one per place, each given `look_seconds` (DATA, 20 by
 * default): macOS can hold a read at a question it asks the person ("would like to access..."), and a place held there
 * is reported as not checked yet instead of guessing refused access or stopping every other place.
 */
export async function lookInChild(input, {seconds = input.look_seconds ?? 20, most_at_once = 4} = {}) {
  const lookAt = row => new Promise(resolve => {
    const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--look'], {stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '', late = false;
    const timer = setTimeout(() => { late = true; child.kill('SIGKILL'); }, seconds * 1000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({sources: [{id: row.id, label: row.label, category: row.category, state: 'could_not_check', detail: error.message.slice(0, 200)}], browser_sites: []}); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) { try { return resolve(JSON.parse(out)); } catch {} }
      // A deadline can be process startup or a held read; only an actual access refusal proves a switch is needed.
      resolve({sources: [{id: row.id, label: row.label, category: row.category, state: 'could_not_check', detail: (late ? `Checking it took longer than ${seconds} seconds.` : err.trim() || `the look ended with ${code}`).slice(0, 200)}], browser_sites: []});
    });
    child.stdin.end(JSON.stringify({...input, rows: [row]}));
  });
  const answers = new Array(input.rows.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(most_at_once, input.rows.length)}, async () => { while (next < input.rows.length) { const index = next++; answers[index] = await lookAt(input.rows[index]); } }));
  return {sources: answers.flatMap(answer => answer.sources), browser_sites: [...new Set(answers.flatMap(answer => answer.browser_sites))]};
}

const computerName = () => new Promise(resolve => execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], {encoding: 'utf8'}, (error, stdout) => resolve((!error && stdout.trim()) || os.hostname().replace(/\.local$/, ''))));

/**
 * rows: computer-sources.json. account(route, {method, body}) -> {status, body} | null (trillion-account.mjs).
 * carriers() -> [{route, status, arrived, last_read_at, latest_item_at, failed}] (read-new-items.mjs status): a place whose reader (its row's `read`) is working
 * and whose first items reached the account is 'reading'.
 * connectionsUrl: the account's Connections page, opened once with the switch's pane when a place needs its switch.
 */
export function computerSources({rows, account, stateFile, workdir, computerId = null, program = 'Trillion', carriers = () => [], connectionsUrl = null, look = lookInChild, name = computerName, open = target => execFile('/usr/bin/open', [target]), home = os.homedir(), log = () => {}}) {
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
  const save = () => { writeFileSync(`${stateFile}.next`, JSON.stringify(state, null, 1)); renameSync(`${stateFile}.next`, stateFile); };
  // One id per computer, shared by every program on it that reports (read-this-computer.mjs), so it is one record.
  state.computer_id = computerId ?? state.computer_id ?? randomUUID();
  let services = null, running = false, last = null;

  // The services this computer carries because an app found here allows it (a row's `carries` with a `works` rule that
  // says so): one card for the computer whose skills name each (`connection:<vendor>`, src/carried-connections.mjs),
  // its capacity renewed on every look so Connections shows each Connected while this program runs. A computer that
  // carried something and now carries nothing publishes the card empty, once.
  async function carry(carried, computer) {
    if (!rows.carrier || (!carried.length && !state.carrying)) return;
    const skills = carried.map(source => ({id: `${rows.carrier.skill_prefix}${source.carries}`, name: source.label}));
    const values = {computer, carried: skills.map(skill => skill.name).join(', ')};
    const card = {agent_id: `${rows.carrier.agent_id_prefix}${state.computer_id}`, name: fill(rows.carrier.name, values), description: fill(rows.carrier.description, values), skills, where: computer, harness: rows.carrier.harness, takes_work: skills.length > 0, capacity: {max_concurrent: skills.length ? 1 : 0, ttl_minutes: rows.carrier.ttl_minutes}};
    const answer = await account('/agents/publish', {method: 'POST', body: card});
    if (answer?.status !== 200) throw new Error(answer ? `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim() : 'not signed in on this Mac');
    state.carrying = skills.length > 0;
  }

  async function lookOnce() {
    if (!services) {
      const answer = await account('/computer-sources/services');
      if (answer?.status !== 200) throw new Error(answer ? `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim() : 'not signed in on this Mac');
      services = answer.body.services ?? [];
    }
    const found = await look({rows: rows.sources, home, domains: services, workdir, look_seconds: rows.look_seconds});
    const reading = carriers();
    const working = new Set(reading.filter(carrier => carrier.status === 'working' && carrier.arrived).map(carrier => carrier.route));
    const byId = new Map(rows.sources.map(row => [row.id, row]));
    const looked = found.sources.map(source => (source.state === 'found' && working.has(byId.get(source.id)?.read?.route) ? {...source, state: 'reading'} : source));
    const sources = looked.map(({carries, ...source}) => source);
    const used = new Set(sources.map(source => source.gate).filter(Boolean));
    const computer = await name();
    await carry(looked.filter(source => source.carries), computer);
    // Reader evidence is metadata only. An item id, title, text or file never enters the discovery report.
    const readers = reading.map(({route, status, last_read_at, latest_item_at, last_sent, failed}) => ({route, status: readerReason(status), last_read_at, latest_item_at,
      last_sent_at: last_sent?.at ?? null, ...(failed ? {failed: {error: readerReason(failed.error), at: failed.at}} : {})}));
    const report = {computer_id: state.computer_id, name: computer, sources, readers, gates: Object.fromEntries([...used].filter(id => rows.gates?.[id]).map(id => [id, {label: fill(rows.gates[id].label, {program}), steps: rows.gates[id].steps.map(step => fill(step, {program}))}])), browser_sites: found.browser_sites};
    last = {at: new Date().toISOString(), found: sources.length, needs_switch: sources.filter(source => source.state === 'needs_switch').length, reading: sources.filter(source => source.state === 'reading').length};
    if (used.size && !state.asked_for_switch_at) {
      state.asked_for_switch_at = new Date().toISOString();
      for (const id of used) if (rows.gates?.[id]?.open) open(rows.gates[id].open);
      if (connectionsUrl) open(connectionsUrl);
    }
    const fingerprint = JSON.stringify(report);
    if (fingerprint === state.sent) { save(); return (last.status = 'unchanged'); }
    const answer = await account('/computer-sources', {method: 'POST', body: report});
    if (answer?.status !== 200) throw new Error(answer ? `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim() : 'not signed in on this Mac');
    state.sent = fingerprint;
    state.sent_at = last.at;
    save();
    log(`This Mac: found ${last.found} places, ${last.reading} reaching the AIs, ${last.needs_switch} waiting for a switch; told the account.`);
    return (last.status = 'sent');
  }

  return {
    async look() {
      if (running) return null;
      running = true;
      try { return await lookOnce(); }
      catch (error) { last = {...(last ?? {}), status: String(error.message ?? error)}; log(`This Mac: could not tell the account what it found: ${last.status}`); return null; }
      finally { running = false; }
    },
    status: () => ({computer_id: state.computer_id, sent_at: state.sent_at ?? null, ...(last ?? {status: 'starting'})}),
  };
}

// Run as a child: reads {rows, home, domains, workdir} on stdin and prints what it found as JSON.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--look') {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try { process.stdout.write(JSON.stringify(lookHere(JSON.parse(input)))); }
    catch (error) { process.stderr.write(String(error.message ?? error)); process.exitCode = 1; }
  });
}
