// What the Trillion app finds on a computer by itself (computer-sources.mjs): each row's place checked by whether it is
// there and may be opened, only the services a browser uses leaving the computer, and the account told once per change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {computerSources, lookHere, lookInChild, SITE_READERS} from '../computer/computer-sources.mjs';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-sources-'));
  const put = (relative, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, relative)), {recursive: true}); fs.writeFileSync(path.join(dir, relative), text); };
  put('Notes/store.sqlite');
  put('Locked/inside/store.db');
  fs.chmodSync(path.join(dir, 'Locked'), 0o000);
  put('Desktop/Screenshot 1.png'); put('Desktop/Screenshot 2.png'); put('Desktop/todo.txt');
  fs.mkdirSync(path.join(dir, 'Volumes/Card A'), {recursive: true}); fs.mkdirSync(path.join(dir, 'Volumes/Main'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'Browser/Default'), {recursive: true});
  const cookies = new DatabaseSync(path.join(dir, 'Browser/Default/Cookies'));
  cookies.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT)');
  for (const host of ['.github.com', 'mail.example.org', '.apple.com']) cookies.prepare('INSERT INTO cookies VALUES (?, ?, ?)').run(host, 'session', 'secret-value');
  cookies.close();
  return dir;
}

const rows = {
  gates: {disk: {label: 'Full Disk Access', open: 'pane:disk', steps: ['Turn it on', 'Reopen the app']}},
  sources: [
    {id: 'notes', label: 'Notes', category: 'Notes', look: {paths: ['~/Notes/store.sqlite']}, gate: 'disk', read: {route: 'Notes carrier'}},
    {id: 'locked', label: 'Locked store', category: 'Messages', look: {paths: ['~/Locked/inside/store.db']}, gate: 'disk'},
    {id: 'absent', label: 'Not here', category: 'Other', look: {paths: ['~/Nowhere/at/all']}},
    {id: 'shots', label: 'Screenshots', category: 'Pictures', look: {entries: '~/Desktop', names_containing: ['Screenshot'], count_as: 'screenshots'}},
    {id: 'drives', label: 'Drive', category: 'Drives', look: {entries: '~/Volumes', each: true, skip: ['Main']}},
    {id: 'sites', label: 'Services your browsers use', category: 'Browsers', look: {browser_sites: [{reader: 'chromium-cookies', paths: ['~/Browser/*/Cookies']}]}},
    {id: 'unknown', label: 'Something new', look: {teleport: ['x']}},
  ],
};
const domains = [{vendor: 'github', domains: ['github.com']}, {vendor: 'notes-app', domains: ['apple.com']}, {vendor: 'photos-app', domains: ['apple.com']}, {vendor: 'stripe', domains: ['stripe.com']}];

test('each place is found, needs its switch, or is left out, and a browser gives up only the services it uses', () => {
  const dir = home();
  const found = lookHere({rows: rows.sources, home: dir, domains, workdir: path.join(dir, 'work')});
  const byId = Object.fromEntries(found.sources.map(source => [source.id, source]));
  assert.equal(byId.notes.state, 'found');
  assert.equal(byId.locked.state, 'needs_switch');
  assert.equal(byId.locked.gate, 'disk');
  assert.equal(byId.absent, undefined);
  assert.equal(byId.shots.detail, '2 screenshots');
  assert.deepEqual(found.sources.filter(source => source.id.startsWith('drives:')).map(source => source.label), ['Card A']);
  assert.equal(byId.unknown.state, 'could_not_check');
  // apple.com belongs to two services, so it names neither; example.org belongs to none.
  assert.deepEqual(found.browser_sites, ['github']);
  assert.doesNotMatch(JSON.stringify(found), /secret-value|example\.org|Default/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), [], 'the copy of the browser store is removed');
  fs.chmodSync(path.join(dir, 'Locked'), 0o755);
});

test('the look also runs in a fresh child process', async () => {
  const dir = home();
  const found = await lookInChild({rows: rows.sources, home: dir, domains, workdir: path.join(dir, 'work')});
  assert.ok(found.sources.some(source => source.id === 'notes'));
  fs.chmodSync(path.join(dir, 'Locked'), 0o755);
});

test('Safari keeps its sites in its own format and only their host names are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safari-'));
  // One page, one cookie whose domain string sits at offset 56 from the cookie's start.
  const cookie = Buffer.alloc(80);
  cookie.writeUInt32LE(80, 0); cookie.writeUInt32LE(56, 16); cookie.write('.stripe.com\0', 56);
  const page = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.from([1, 0, 0, 0]), Buffer.from([16, 0, 0, 0]), Buffer.alloc(4), cookie]);
  const head = Buffer.alloc(12); head.write('cook', 0); head.writeUInt32BE(1, 4); head.writeUInt32BE(page.length, 8);
  fs.writeFileSync(path.join(dir, 'Cookies.binarycookies'), Buffer.concat([head, page]));
  assert.deepEqual(SITE_READERS['safari-cookies'](path.join(dir, 'Cookies.binarycookies')), ['.stripe.com']);
});

test('the account is told once per change, a working reader makes a place Connected, and the switch is asked for once', async () => {
  const dir = home();
  const sent = [], opened = [];
  const account = async (route, {method = 'GET', body} = {}) => {
    if (method === 'GET') return {status: 200, body: {services: domains}};
    sent.push(body);
    return {status: 200, body: {kept: true}};
  };
  const make = () => computerSources({rows, account, stateFile: path.join(dir, 'state.json'), workdir: path.join(dir, 'work'), home: dir, look: lookHere, name: async () => 'Studio Mac',
    carriers: () => [{route: 'Notes carrier', status: 'working', arrived: true, last_read_at: '2026-10-07T10:00:00Z', latest_item_at: '2026-10-07T09:00:00Z', last_sent: {at: '2026-10-07T09:05:00Z', message_id: 'private-message'},
      failed: {source_id: 'private-item-id', error: 'account answered 400', at: '2026-10-07T09:01:00Z'}}], connectionsUrl: 'https://account/connections', open: target => opened.push(target)});
  const seeker = make();
  assert.equal(await seeker.look(), 'sent');
  assert.equal(await seeker.look(), 'unchanged');
  assert.equal(await make().look(), 'unchanged', 'a restart remembers what was already told');
  assert.equal(sent.length, 1);
  const [report] = sent;
  assert.equal(report.name, 'Studio Mac');
  assert.equal(report.sources.find(source => source.id === 'notes').state, 'reading');
  assert.deepEqual(report.readers, [{route: 'Notes carrier', status: 'working', last_read_at: '2026-10-07T10:00:00Z', latest_item_at: '2026-10-07T09:00:00Z', last_sent_at: '2026-10-07T09:05:00Z', failed: {error: 'the account answered 400', at: '2026-10-07T09:01:00Z'}}]);
  assert.doesNotMatch(JSON.stringify(report), /private-item-id/);
  assert.deepEqual(Object.keys(report.gates), ['disk']);
  assert.deepEqual(report.browser_sites, ['github']);
  assert.deepEqual(opened, ['pane:disk', 'https://account/connections']);
  assert.equal(seeker.status().found, report.sources.length);
  fs.chmodSync(path.join(dir, 'Locked'), 0o755);
});

test('an account that cannot be reached is said, and nothing is marked as told', async () => {
  const dir = home();
  const seeker = computerSources({rows, account: async () => null, stateFile: path.join(dir, 'state.json'), workdir: path.join(dir, 'work'), home: dir, look: lookHere, name: async () => 'Mac'});
  assert.equal(await seeker.look(), null);
  assert.equal(seeker.status().status, 'not signed in on this Mac');
  fs.chmodSync(path.join(dir, 'Locked'), 0o755);
});

test('a check deadline is unknown access without a switch, and a later normal check can find the open place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
  execFileSync('/usr/bin/mkfifo', [path.join(dir, 'held')]);
  fs.writeFileSync(path.join(dir, 'open'), 'x');
  const started = Date.now();
  const found = await lookInChild({rows: [
    {id: 'held', label: 'Held', category: 'Notes', look: {paths: [path.join(dir, 'held')]}, gate: 'disk'},
    {id: 'held-no-switch', label: 'Held too', look: {paths: [path.join(dir, 'held')]}},
    {id: 'open', label: 'Open', look: {paths: [path.join(dir, 'open')]}},
  ], home: dir, domains: [], workdir: path.join(dir, 'work'), look_seconds: 1});
  assert.ok(Date.now() - started < 8000, 'a held place costs only its own time limit');
  assert.deepEqual(found.sources.slice(0, 2).map(source => [source.id, source.state, source.gate ?? null]), [['held', 'could_not_check', null], ['held-no-switch', 'could_not_check', null]]);
  for (const source of found.sources.filter(source => source.id.startsWith('held'))) assert.match(source.detail, /Checking it took longer than 1 seconds/);
  // Startup is part of each deadline. A loaded Mac can miss this deliberately short window even for an open file.
  // Such a result must remain unknown access, while a normal fresh-child check independently proves that file is found.
  const open = found.sources[2];
  assert.equal(open.id, 'open');
  assert.equal(open.gate, undefined);
  assert.ok(['found', 'could_not_check'].includes(open.state));
  if (open.state === 'could_not_check') assert.match(open.detail, /Checking it took longer than 1 seconds/);
  const checkedOpen = await lookInChild({rows: [{id: 'open', label: 'Open', look: {paths: [path.join(dir, 'open')]}}],
    home: dir, domains: [], workdir: path.join(dir, 'work')});
  assert.deepEqual(checkedOpen.sources.map(source => [source.id, source.state, source.gate ?? null]), [['open', 'found', null]]);
  const opened = [], sent = [];
  const seeker = computerSources({rows: {sources: rows.sources, gates: rows.gates}, account: async (route, {body} = {}) => { if (body) sent.push(body); return {status: 200, body: {services: []}}; }, stateFile: path.join(dir, 'state.json'), workdir: path.join(dir, 'work'), look: async () => found, name: async () => 'Studio Mac', open: target => opened.push(target), connectionsUrl: 'https://account/connections'});
  assert.equal(await seeker.look(), 'sent');
  assert.deepEqual(opened, [], 'neither Privacy nor Connections opens without a real refused access');
  assert.deepEqual(sent[0].gates, {}, 'a deadline does not publish a permission gate');
  assert.equal(seeker.status().needs_switch, 0);
});

// An app that says what it is: its own property list names its version and edition, and the row's rules decide what
// the person's AIs can do with it and whether this computer carries its service.
const appRow = {id: 'editor', label: 'An editor', category: 'Editing', carries: 'an-editor', look: {paths: ['~/Apps/Editor.app'], facts: {file: 'Contents/Info.plist', keys: {version: 'CFBundleShortVersionString', name: 'CFBundleName'}}, works: [
  {if: [{fact: 'name', contains: 'Pro'}], carries: true, detail: '{name} {version} can be worked in.'},
  {if: [{fact: 'version', below: '21.1'}], carries: true, detail: '{name} {version}, older, can be worked in.'},
  {if: [{fact: 'version', at_least: '21.1'}], detail: '{name} {version} lets nothing in.'},
]}};
function appAt(dir, name, version) {
  fs.mkdirSync(path.join(dir, 'Apps/Editor.app/Contents'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'Apps/Editor.app/Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>${name}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
}

test('an app found is asked what it is, and the first rule that holds says what it allows and what this computer carries', {skip: process.platform !== 'darwin' && 'plutil is macOS'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-apps-'));
  const look = () => lookHere({rows: [appRow], home: dir}).sources[0];
  assert.equal(look(), undefined, 'not installed: not reported');
  appAt(dir, 'Editor', '21.1.1');
  assert.deepEqual(look(), {id: 'editor', label: 'An editor', category: 'Editing', state: 'found', detail: 'Editor 21.1.1 lets nothing in.'});
  appAt(dir, 'Editor', '21.0.3');
  assert.equal(look().carries, 'an-editor', '21.0.3 is below 21.1 (each part compared as a number)');
  appAt(dir, 'Editor', '21.10');
  assert.equal(look().carries, undefined, '21.10 is after 21.1');
  appAt(dir, 'Editor Pro', '22.0');
  assert.deepEqual(look(), {id: 'editor', label: 'An editor', category: 'Editing', state: 'found', detail: 'Editor Pro 22.0 can be worked in.', carries: 'an-editor'});
});

test('a computer that carries an app\'s service publishes one card naming it, renewed every look, and empties it once when it stops', {skip: process.platform !== 'darwin' && 'plutil is macOS'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-carries-'));
  appAt(dir, 'Editor Pro', '22.0');
  const published = [], reports = [];
  const account = async (route, {method = 'GET', body} = {}) => {
    if (method === 'GET') return {status: 200, body: {services: []}};
    (route === '/agents/publish' ? published : reports).push(body);
    return {status: 200, body: {}};
  };
  const carrier = {agent_id_prefix: 'apps-', skill_prefix: 'connection:', harness: 'trillion-computer-sources', name: '{computer}', description: 'Apps on {computer}: {carried}.', ttl_minutes: 30};
  const seeker = computerSources({rows: {sources: [appRow], carrier}, account, stateFile: path.join(dir, 'state.json'), workdir: path.join(dir, 'work'), computerId: 'mac-1', home: dir, look: lookHere, name: async () => 'Studio Mac'});
  assert.equal(await seeker.look(), 'sent');
  assert.equal(await seeker.look(), 'unchanged');
  assert.equal(published.length, 2, 'the card is renewed on every look, even when nothing else changed');
  assert.deepEqual(published[0], {agent_id: 'apps-mac-1', name: 'Studio Mac', description: 'Apps on Studio Mac: An editor.', skills: [{id: 'connection:an-editor', name: 'An editor'}], where: 'Studio Mac', harness: 'trillion-computer-sources', takes_work: true, capacity: {max_concurrent: 1, ttl_minutes: 30}});
  assert.equal(reports.length, 1);
  assert.equal(reports[0].sources[0].carries, undefined, 'the report itself carries names and states only');
  appAt(dir, 'Editor', '21.1.1');
  await seeker.look();
  await seeker.look();
  assert.equal(published.length, 3, 'once it carries nothing the card is emptied once, then left alone');
  assert.deepEqual(published[2].skills, []);
  assert.equal(published[2].capacity.max_concurrent, 0);
});
