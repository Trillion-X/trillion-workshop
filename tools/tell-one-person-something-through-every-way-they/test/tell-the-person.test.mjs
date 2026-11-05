// Telling a person something goes through the channels its kind goes through, only those the person has on and that
// can send; one failing channel never stops the others; the same key tells them once; the person's choices override
// the rows and nothing else; and the rows, the Workshop tool and the starting rule that runs it agree with each other.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { keptListSender, makeTellThePerson, handleTellRequest, kindChannels } from '../read-data/tell-the-person.mjs';
import { tellDevices } from '../../tell-the-person-something-on-all-of-their-own-phones-computers/src/tell-devices.mjs';

const rows = JSON.parse(readFileSync(new URL('../read-data/tell-the-person.json', import.meta.url), 'utf8'));
const toolRows = JSON.parse(readFileSync(new URL('../../keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const starting = JSON.parse(readFileSync(new URL('../../starting-set/starting-rules.json', import.meta.url), 'utf8'));
const channelsOf = id => kindChannels(rows.kinds.find(kind => kind.id === id), rows.channels);
const live = new Set(rows.channels.filter(row => row.while_running).map(row => row.id));

function owner({ ready = {}, fail = [], roads = {}, presence = () => [], clock = { at: new Date('2026-09-29T20:00:00Z') }, quietNow, quietRow } = {}) {
  let choices = null;
  let notices = [];
  const sent = [];
  const stand = name => ({
    state: row => (ready[row.id] === false ? { ready: false, need: row.sender === 'connection-tool' ? 'connection' : 'setup', connect_url: 'https://app.gettrillion.ai/connect/x' } : { ready: true }),
    send: (row, notice, { shown, board }) => {
      if (fail.includes(row.id)) throw new Error(`${row.label} broke`);
      sent.push({ channel: row.id, sender: name, title: notice.title, open: notice.open, shown, board });
      return { sent: true, said: `sent by ${name}` };
    },
  });
  const senders = Object.fromEntries([...new Set(rows.channels.map(row => row.sender))].map(name => [name, stand(name)]));
  const tell = makeTellThePerson({
    rows, senders, roads, presence, now: () => clock.at, ...(quietNow ? { quietNow } : {}), ...(quietRow ? { quietRow } : {}),
    store: { choices: () => choices, putChoices: value => { choices = structuredClone(value); }, notices: () => notices, putNotices: list => { notices = structuredClone(list); } },
  });
  return { tell, sent, notices: () => notices };
}

test('a kind goes through its own channels that are on, and its address is filled from refs', async () => {
  const { tell, sent } = owner();
  const told = await tell.tell({ kind: 'video-made', title: 'A new video is in your files', body: ['/Clips/a.mp4'], refs: { file: '1f:abc' }, key: 'file-arrival:1f:abc' });
  assert.equal(told.told, true);
  assert.deepEqual(sent.map(item => item.channel).sort(), channelsOf('video-made').filter(id => !live.has(id)).sort());
  assert.equal(sent[0].open, '/file/1f:abc');
  assert.equal(tell.recent().notices[0].preview_identity, '1f:abc');
});

test('a new request reaches the Mac, phone and iMessage once with its direct link', async () => {
  const { tell, sent } = owner();
  const input = { kind: 'needs-you-request', key: 'waiting-ask:connect-account', title: 'Connect the account',
    open: 'https://app.gettrillion.ai/connections', refs: { card: 'asks:connect-account', open: 'https://app.gettrillion.ai/connections' } };
  assert.equal((await tell.tell(input)).told, true);
  assert.deepEqual(sent.map(item => item.channel).sort(), ['in-app', 'this-computer', 'phone', 'mac-app', 'imessage'].sort());
  assert.ok(sent.every(item => item.open === input.open));
  assert.equal((await tell.tell(input)).told, false);
  assert.equal(sent.length, 5);
});

test('the same key tells nobody twice, and an unknown kind is told as the default kind', async () => {
  const { tell, sent } = owner();
  await tell.tell({ title: 'Hello', key: 'k1' });
  const again = await tell.tell({ title: 'Hello', key: 'k1' });
  assert.equal(again.told, false);
  assert.equal(sent.length, rows.kinds.find(kind => kind.id === rows.default_kind).channels.length);
  await tell.tell({ kind: 'no-such-kind', title: 'Other', key: 'k2' });
  assert.equal(sent.length, 2 * rows.kinds.find(kind => kind.id === rows.default_kind).channels.length);
});

test('the same key with update changes the notice words in place and sends nothing again', async () => {
  const { tell, sent, notices } = owner();
  await tell.tell({ title: 'Cloudflare: reached', body: '$617 of $300 this month.', key: 'bill' });
  const channels = sent.length;
  const changed = await tell.tell({ title: 'Cloudflare: reached', body: '$820 of $300 this month.', key: 'bill', update: true });
  assert.equal(changed.updated, true);
  assert.equal(sent.length, channels, 'an update sends nothing');
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].body, '$820 of $300 this month.');
  const same = await tell.tell({ title: 'Cloudflare: reached', body: '$820 of $300 this month.', key: 'bill', update: true });
  assert.equal(same.updated, undefined, 'the same words change nothing');
  const plain = await tell.tell({ title: 'Cloudflare: reached', body: '$900 of $300 this month.', key: 'bill' });
  assert.equal(plain.told, false);
  assert.equal(notices()[0].body, '$820 of $300 this month.', 'without update the first words stay');
});

test('a channel that cannot send says why, and a failing channel never stops the others', async () => {
  const { tell, sent } = owner({ ready: { 'this-computer': false }, fail: ['email'] });
  await tell.choose({ channels: { email: { on: true, address: 'sam@example.com' } } });
  const told = await tell.tell({ kind: 'needs-you', title: 'Waiting for your answer', key: 'k3' });
  const by = Object.fromEntries(told.channels.map(item => [item.channel, item]));
  assert.equal(by['this-computer'].sent, false);
  assert.equal(by['this-computer'].said, rows.needs.setup);
  assert.equal(by.email.sent, false);
  assert.match(by.email.said, /broke/);
  assert.deepEqual(sent.map(item => item.channel).sort(), channelsOf('needs-you').filter(id => !['this-computer', 'email'].includes(id)).sort());
});

test('the person\'s choices override only what they chose, and nonsense is refused', async () => {
  const { tell, sent } = owner();
  const settings = await tell.choose({ channels: { 'this-computer': { on: false } }, kinds: { 'video-made': ['in-app', 'email'] } });
  assert.equal(settings.channels.find(channel => channel.id === 'this-computer').on, false);
  assert.deepEqual(settings.kinds.find(kind => kind.id === 'video-made').channels, ['in-app', 'email']);
  assert.deepEqual(settings.kinds.find(kind => kind.id === 'work-finished').channels, rows.kinds.find(kind => kind.id === 'work-finished').channels);
  await tell.tell({ kind: 'work-finished', title: 'Done', key: 'k4' });
  assert.deepEqual(sent.map(item => item.channel), channelsOf('work-finished').filter(id => id !== 'this-computer'), 'work-finished follows its row, with this computer switched off');
  await assert.rejects(tell.choose({ channels: { pager: { on: true } } }), /no way to be told/);
  await assert.rejects(tell.choose({ kinds: { 'video-made': ['pager'] } }), /does not exist/);
  await assert.rejects(tell.choose({ channels: { email: { address: 'not an address' } } }), /email address/);
});

test('a channel waiting on a connection says to connect it, with the link', async () => {
  const { tell } = owner({ ready: { telegram: false } });
  const settings = await tell.settings();
  const telegram = settings.channels.find(channel => channel.id === 'telegram');
  assert.deepEqual(telegram.state, { ready: false, need: 'connection', said: 'Connect Telegram to turn this on.', connect_url: 'https://app.gettrillion.ai/connect/x' });
});

test('the page shows what its own channel carried, and read marks stick', async () => {
  const { tell } = owner();
  await tell.tell({ title: 'First', key: 'a' });
  await tell.tell({ title: 'Second', key: 'b' });
  const { notices } = tell.recent();
  assert.deepEqual(notices.map(item => item.title), ['Second', 'First']);
  tell.markRead({ ids: [notices[0].id] });
  assert.deepEqual(tell.recent().notices.map(item => item.read), [true, false]);
});

test('the routes answer the owner, and a bad change is a 400', async () => {
  const { tell } = owner();
  const settings = await (await handleTellRequest({ tell }, new Request('https://person/tell'))).json();
  assert.equal(settings.channels.length, rows.channels.length);
  const refused = await handleTellRequest({ tell }, new Request('https://person/tell', { method: 'POST', body: JSON.stringify({ channels: { pager: {} } }) }));
  assert.equal(refused.status, 400);
  assert.equal((await handleTellRequest({ tell }, new Request('https://person/tell/nope'))).status, 404);
});

test('the rows, the Workshop tool and the starting rule agree', () => {
  const ids = new Set(rows.channels.map(row => row.id));
  for (const kind of rows.kinds) for (const channel of kindChannels(kind, rows.channels)) assert.ok(ids.has(channel), `${kind.id} names ${channel}`);
  assert.ok(ids.has(rows.shown_here));
  assert.ok(rows.kinds.some(kind => kind.id === rows.default_kind));
  assert.equal(keptListSender.state().ready, true);
  const tool = toolRows.find(row => row.id === 'tool:tell-the-person');
  assert.deepEqual(tool.invoke, { kind: 'account-action', action: 'tell-the-person' });
  const rule = starting.every_account.find(row => row.rule_id === 'starting:tell-you-about-new-videos');
  assert.equal(rule.then.tool_id, tool.id);
  assert.ok(rows.kinds.some(kind => kind.id === rule.then.input.kind));
  for (const field of Object.keys(rule.then.input)) assert.ok(tool.input_schema.properties[field], `the tool takes ${field}`);
});

test('work still going on is one notice changed in place, shown only in Trillion while it runs, and told once when it ends', async () => {
  const { tell, sent, notices } = owner();
  await tell.report({ key: 'copy:1', kind: 'transfer', title: 'Copying a drive', source: 'This Mac', progress: { done: 10, total: 100, unit: 'bytes' } });
  await tell.report({ key: 'copy:1', kind: 'transfer', title: 'Copying a drive', source: 'This Mac', progress: { done: 60, total: 100, unit: 'bytes' } });
  assert.equal(notices().length, 1);
  const drawsLive = channelsOf('transfer').filter(id => live.has(id));
  assert.deepEqual(sent.map(item => item.channel), [...drawsLive, ...drawsLive], 'a running report goes only to the channels that draw work live, every time');
  sent.length = 0;
  const [running] = tell.recent().notices;
  assert.equal(running.state, 'running');
  assert.deepEqual(running.progress, { done: 60, total: 100, unit: 'bytes' });
  assert.equal(running.source, 'This Mac');
  const ended = await tell.report({ key: 'copy:1', kind: 'transfer', title: 'Copied a drive', state: 'done', progress: { done: 100, total: 100, unit: 'bytes' } });
  assert.equal(ended.state, 'done');
  const kind = rows.kinds.find(row => row.id === 'transfer');
  assert.deepEqual(sent.map(item => item.channel).sort(), kindChannels(kind, rows.channels).filter(id => id !== rows.shown_here).sort());
  const again = await tell.report({ key: 'copy:1', kind: 'transfer', title: 'Copied a drive', state: 'done' });
  assert.equal(again.reported, false);
  assert.equal(sent.length, kindChannels(kind, rows.channels).length - 1, 'an ended job is told once');
  assert.equal(sent.find(item => live.has(item.channel)).shown.state, 'done', 'the live channel hears the end');
  assert.equal(tell.recent().notices[0].title, 'Copied a drive');
});

test('a running report not heard from for the quiet minutes reads as stopped, and bad counts or an outside address are refused', async () => {
  let at = new Date('2026-09-29T20:00:00Z');
  let notices = [];
  const tell = makeTellThePerson({ rows, senders: { 'kept-list': keptListSender }, now: () => at,
    store: { choices: () => null, putChoices: () => {}, notices: () => notices, putNotices: list => { notices = structuredClone(list); } } });
  await tell.report({ key: 'k', title: 'Making a video', open: '//elsewhere.example/x' });
  assert.equal(tell.recent().notices[0].open, rows.default_open);
  at = new Date(at.getTime() + (rows.running_quiet_minutes + 1) * 60_000);
  assert.equal(tell.recent().notices[0].state, 'stopped');
  await assert.rejects(tell.report({ key: 'k2', title: 'x', progress: { done: 5, total: 2 } }), /done no more than total/);
  await assert.rejects(tell.report({ title: 'no key' }), /key/);
  await assert.rejects(tell.report({ key: 'k3', title: 'x', state: 'maybe' }), /state is one of/);
});

test('the report tool row, the account action and the run rows agree with the kinds', () => {
  const tool = toolRows.find(row => row.id === 'tool:report-progress');
  assert.equal(tool.invoke.action, 'report-progress');
  const runs = JSON.parse(readFileSync(new URL('../read-data/run-progress.json', import.meta.url), 'utf8'));
  const kinds = new Set(rows.kinds.map(kind => kind.id));
  for (const [id, row] of Object.entries(runs.tools)) assert.ok(kinds.has(row.kind), `${id} names kind ${row.kind}, which records/tell-the-person.json has no row for`);
  for (const state of Object.values(runs.states)) assert.ok(rows.work_states.includes(state));
});

test('an action a running report offers goes to the agent that reported it, once per press, and nothing else is pressed', async () => {
  const asked = [];
  let notices = [];
  const tell = makeTellThePerson({ rows, senders: { 'kept-list': keptListSender }, askAgent: async said => { asked.push(said); return { event: { event_id: `ev_${asked.length}` } }; },
    store: { choices: () => null, putChoices: () => {}, notices: () => notices, putNotices: list => { notices = structuredClone(list); } } });
  await tell.report({ key: 'copy:a', kind: 'transfer', title: 'Copying a drive', source: 'This Mac', actions: [{ id: 'pause', label: 'Pause' }, { id: 'stop', label: 'Stop' }], answered_by: 'computer-this-mac' });
  const [card] = tell.recent().notices;
  assert.deepEqual(card.actions.map(action => action.id), ['pause', 'stop']);
  const answer = await tell.act({ id: card.id, action: 'pause' });
  assert.equal(answer.asked, true);
  assert.match(answer.said, /Asked This Mac to Pause/);
  assert.equal(asked[0].type, rows.action_event);
  assert.equal(asked[0].to_agent, 'computer-this-mac');
  assert.deepEqual(asked[0].refs, { key: 'copy:a', action: 'pause' });
  await assert.rejects(tell.act({ id: card.id, action: 'delete' }), /not something this work offers/);
  await assert.rejects(tell.report({ key: 'copy:b', title: 'x', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], answered_by: 'x' }), /at most 2/);
  await assert.rejects(tell.report({ key: 'copy:c', title: 'x', actions: [{ id: 'pause', label: 'Pause' }] }), /answered_by/);
  await tell.report({ key: 'copy:a', kind: 'transfer', title: 'Copied a drive', state: 'done' });
  assert.equal(tell.recent().notices[0].actions, undefined, 'ended work offers nothing');
  await assert.rejects(tell.act({ id: card.id, action: 'pause' }), /not something this work offers/);
  assert.equal(asked.length, 1);
});

test('a device sees each notice with its kind\'s buttons and loudness, and reads only what its own channel carried', async () => {
  const { tell, sent } = owner();
  await tell.tell({ kind: 'needs-you', title: 'Pick the cover', body: 'Two options', key: 'n1' });
  await tell.tell({ kind: 'update', title: 'Only in Trillion', key: 'n2' });
  const shown = sent.find(item => item.channel === 'phone').shown;
  assert.equal(shown.level, rows.kinds.find(kind => kind.id === 'needs-you').level);
  assert.deepEqual(shown.actions.map(action => action.id), rows.default_actions);
  const reply = shown.actions.find(action => action.id === 'reply');
  assert.ok(reply.input.placeholder && reply.input.button, 'a reply asks for words');
  assert.equal(shown.actions.find(action => action.id === 'open').opens, true);
  for (const action of shown.actions) assert.equal(action.road, undefined, 'a device never sees what an action does');
  const { notices } = tell.forDevice({ channel: 'mac-app' });
  assert.deepEqual(notices.map(item => item.title), ['Pick the cover']);
  assert.deepEqual(tell.forDevice({ channel: 'mac-app', after: notices[0].seq }).notices, []);
  assert.throws(() => tell.forDevice({ channel: 'pager' }), /no way to be told/);
});

test('a button press runs the road its action names, with the words typed, and marks the notice read', async () => {
  const heard = [];
  const { tell } = owner({ roads: { reply: ({ notice, text, row, submission_id }) => { heard.push({ title: notice.title, text, message: row.message, submission_id }); return {}; }, open: ({ notice }) => ({ open: notice.open }), read: () => ({}) } });
  await tell.tell({ kind: 'needs-you', title: 'Pick the cover', key: 'n1' });
  const id = tell.forDevice({ channel: 'phone' }).notices[0].id;
  await assert.rejects(tell.act({ id, action: 'reply' }), /Write what to send/);
  const response = await handleTellRequest({ tell }, new Request('https://person/tell/notices/act', { method: 'POST', body: JSON.stringify({ id, action: 'reply', text: '  the blue one ', submission_id: '00000000-0000-4000-8000-000000000001' }) }));
  const replied = await response.json();
  assert.equal(response.status, 200);
  assert.equal(replied.done, true);
  assert.deepEqual(heard, [{ title: 'Pick the cover', text: 'the blue one', message: rows.actions.find(row => row.id === 'reply').message, submission_id: '00000000-0000-4000-8000-000000000001' }]);
  await assert.rejects(tell.act({ id, action: 'reply', text: 'another reply', submission_id: 'invalid' }), /reply could not be sent/);
  assert.equal(tell.forDevice({ channel: 'phone' }).notices[0].read, true);
  assert.equal((await tell.act({ id, action: 'open' })).open, rows.default_open);
  await assert.rejects(tell.act({ id, action: 'launch' }), /not something this notice offers/);
});

test('devices register once per address on their route, carry no address out, and a gone one is forgotten', () => {
  let kept = null;
  const devices = tellDevices({ read: () => kept, write: list => { kept = structuredClone(list); } }, { routes: rows.devices.routes, now: () => new Date('2026-10-03T10:00:00Z') });
  const token = 'ab'.repeat(32);
  const first = devices.add({ route: 'apns', address: token, label: 'iPhone', app: 'ai.gettrillion.ios', environment: 'production' });
  const writes = JSON.stringify(kept);
  const again = devices.add({ route: 'apns', address: token.toUpperCase(), label: 'iPhone', app: 'ai.gettrillion.ios', environment: 'production' });
  assert.equal(again.device_id, first.device_id);
  assert.equal(JSON.stringify(kept), writes, 'registering again with nothing changed writes nothing');
  devices.add({ route: 'live', address: 'C0FFEE00-1234-4abc-9def-001122334455', label: 'Trillion for Mac' });
  assert.equal(devices.listed().length, 2);
  for (const device of devices.listed()) assert.equal(device.address, undefined);
  assert.equal(devices.of('apns')[0].address, token);
  assert.throws(() => devices.add({ route: 'apns', address: 'not hex' }), /hex/);
  assert.throws(() => devices.add({ route: 'pager', address: token }), /no device route/);
  assert.throws(() => devices.add({ route: 'web-push', address: { endpoint: 'http://push.example/x' } }), /https endpoint/);
  devices.forget(first.device_id);
  assert.deepEqual(devices.listed().map(device => device.route), ['live']);
});

test('the device routes answer a device: register, list with the web push key, read a channel after a seq, remove', async () => {
  const { tell } = owner();
  let kept = null;
  const devices = tellDevices({ read: () => kept, write: list => { kept = list; } }, { routes: rows.devices.routes });
  const own = { tell, devices, webPushKey: () => 'BPk', activities: { keep: () => ({ kept: true }) } };
  const call = (path, body) => handleTellRequest(own, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
  const missing = await (await call('/tell/devices/find', { route: 'live', address: 'mac-0001-device' })).json();
  assert.deepEqual(missing, { found: false, registration_matches: false });
  assert.equal(kept, null, 'a lookup does not register or write a device');
  const invalidFind = await call('/tell/devices/find', { route: 'live', address: '!' });
  assert.equal(invalidFind.status, 400);
  const added = await (await call('/tell/devices', { route: 'live', address: 'mac-0001-device', label: 'Trillion for Mac' })).json();
  const found = await (await call('/tell/devices/find', { route: 'live', address: 'mac-0001-device' })).json();
  assert.deepEqual(found, { found: true, device_id: added.device_id, registration_matches: true });
  assert.equal(JSON.stringify(found).includes('mac-0001-device'), false);
  const pushAddress = { endpoint: 'https://push.example/subscription', keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
  const pushAdded = await (await call('/tell/devices', { route: 'web-push', address: pushAddress, label: 'Browser' })).json();
  const heldPush = kept.find(row => row.device_id === pushAdded.device_id);
  heldPush.address = { keys: { auth: pushAddress.keys.auth, p256dh: pushAddress.keys.p256dh }, endpoint: pushAddress.endpoint };
  assert.equal((await (await call('/tell/devices/find', { route: 'web-push', address: pushAddress })).json()).registration_matches, true, 'same normalized keys match regardless of legacy property order');
  const changedKeys = { ...pushAddress, keys: { p256dh: Buffer.alloc(65, 3).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') } };
  assert.deepEqual(await (await call('/tell/devices/find', { route: 'web-push', address: changedKeys })).json(), { found: true, device_id: pushAdded.device_id, registration_matches: false });
  const listed = await (await call('/tell/devices')).json();
  assert.equal(listed.web_push_key, 'BPk');
  assert.deepEqual(listed.devices.map(device => device.device_id), [added.device_id, pushAdded.device_id]);
  assert.equal((await call('/tell/devices', { route: 'live', address: '!' })).status, 400);
  await tell.tell({ kind: 'work-finished', title: 'Done', key: 'w1' });
  const read = await (await call('/tell/notices?channel=mac-app&after=0')).json();
  assert.deepEqual(read.notices.map(item => item.title), ['Done']);
  assert.ok(Array.isArray((await (await call('/tell/notices')).json()).notices));
  await call('/tell/devices/remove', { device_id: added.device_id });
  assert.deepEqual((await (await call('/tell/devices/remove', { device_id: pushAdded.device_id })).json()).devices, []);
});

test('a road that refuses with its own status answers with that status and its words', async () => {
  const refusal = Object.assign(new Error('This is part of a paid plan.'), { status: 402, upgrade_needed: true });
  const { tell } = owner({ roads: { reply: () => { throw refusal; } } });
  await tell.tell({ kind: 'needs-you', title: 'Pick the cover', key: 'n1' });
  const id = tell.forDevice({ channel: 'phone' }).notices[0].id;
  const answer = await handleTellRequest({ tell }, new Request('https://person/tell/notices/act', { method: 'POST', body: JSON.stringify({ id, action: 'reply', text: 'blue' }) }));
  assert.equal(answer.status, 402);
  assert.deepEqual(await answer.json(), { error: 'This is part of a paid plan.', upgrade_needed: true });
});

test('a notice keeps the chips it was sent, drops them when a later report sends none, and refuses a malformed list', async () => {
  const { tell } = owner();
  await tell.report({ key: 'copy:2', kind: 'transfer', title: 'Copying', chips: [{ text: '3 of 9 files' }, { text: 'Paused', tone: 'attention' }] });
  assert.deepEqual(tell.recent().notices[0].chips, [{ text: '3 of 9 files' }, { text: 'Paused', tone: 'attention' }]);
  await tell.report({ key: 'copy:2', kind: 'transfer', title: 'Copying' });
  assert.equal(tell.recent().notices[0].chips, undefined);
  await assert.rejects(tell.report({ key: 'copy:3', title: 'x', chips: [{ tone: 'attention' }] }), /chips/);
  await assert.rejects(tell.report({ key: 'copy:3', title: 'x', chips: Array.from({ length: rows.chips_most + 1 }, () => ({ text: 'a' })) }), /chips/);
  await tell.tell({ key: 'news:1', title: 'Made a video', chips: [{ text: '2 min' }] });
  assert.deepEqual(tell.recent().notices.find(item => item.title === 'Made a video').chips, [{ text: '2 min' }]);
});

test('a live channel is sent its whole board: every job it carries that still runs, newest first, quiet ones dropped', async () => {
  const clock = { at: new Date('2026-10-04T08:00:00Z') };
  const { tell, sent } = owner({ clock });
  const [channel] = live;
  // A kind that keeps the rows' own quiet time (a kind's quiet_minutes keeps its notices up longer).
  const kind = rows.kinds.find(row => kindChannels(row, rows.channels).includes(channel) && row.quiet_minutes === undefined).id;
  const boardOf = () => sent.filter(item => item.channel === channel).at(-1).board;
  await tell.report({ key: 'drive', kind, title: 'Keeping 1TB SSD', progress: { done: 1, total: 4 } });
  clock.at = new Date('2026-10-04T08:01:00Z');
  await tell.report({ key: 'export', kind, title: 'Making your video' });
  assert.deepEqual(boardOf().map(item => item.title), ['Making your video', 'Keeping 1TB SSD']);
  assert.equal(boardOf()[1].progress.done, 1);
  // The drive goes quiet; the next report draws the board without it.
  clock.at = new Date(Date.parse('2026-10-04T08:00:00Z') + (rows.running_quiet_minutes + 1) * 60_000);
  await tell.report({ key: 'export', kind, title: 'Making your video', progress: { done: 3, total: 9 } });
  assert.deepEqual(boardOf().map(item => item.title), ['Making your video']);
  // The last job ends: its board holds only it, ended, so the device ends the board.
  await tell.report({ key: 'export', kind, title: 'Your video is ready', state: 'done' });
  assert.deepEqual(boardOf().map(item => [item.title, item.state]), [['Your video is ready', 'done']]);
});

test('glance feeds are DATA a device reads: each names how to read its rows and which parts to draw', async () => {
  const feeds = JSON.parse(readFileSync(new URL('../read-data/glance-feeds.json', import.meta.url), 'utf8')).feeds;
  const answer = await (await handleTellRequest({}, new Request('https://person/tell/feeds'))).json();
  assert.deepEqual(answer.feeds, feeds);
  for (const feed of feeds) {
    assert.ok(feed.id && feed.label && feed.empty, feed.id);
    assert.ok(Boolean(feed.read.path) !== Boolean(feed.read.tool), `${feed.id} reads a path or a tool`);
    assert.ok(Array.isArray(feed.rows) && Array.isArray(feed.show.title), feed.id);
  }
});

test('every glance surface names feeds that exist, and Running now leaves out exactly the Waiting on you board', () => {
  const glance = JSON.parse(readFileSync(new URL('../read-data/glance-feeds.json', import.meta.url), 'utf8'));
  const ids = new Set(glance.feeds.map(feed => feed.id));
  for (const [surface, shown] of Object.entries(glance.surfaces)) for (const id of shown) assert.ok(ids.has(id), `${surface} names ${id}`);
  const waiting = JSON.parse(readFileSync(new URL('../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json', import.meta.url), 'utf8')).nudge;
  const boardKinds = [...new Set([waiting.notice_kind, ...waiting.ladder.map(rung => rung.kind)])].sort();
  const running = glance.feeds.find(feed => feed.id === 'running');
  const left = [running.where].flat().find(test => test.none_of)?.none_of ?? [];
  assert.deepEqual([...left].sort(), boardKinds);
  const kinds = new Set(rows.kinds.map(kind => kind.id));
  for (const kind of boardKinds) assert.ok(kinds.has(kind), kind);
});

test('a kind with its own quiet time keeps its running notice up between its reports', async () => {
  const clock = { at: new Date('2026-10-06T08:00:00Z') };
  const { tell, sent } = owner({ clock });
  const [channel] = live;
  const slow = rows.kinds.find(row => kindChannels(row, rows.channels).includes(channel) && row.quiet_minutes > rows.running_quiet_minutes);
  assert.ok(slow, 'a kind such as the Waiting on you board keeps longer');
  await tell.report({ key: 'waiting', kind: slow.id, title: 'Waiting on you: 1' });
  clock.at = new Date(Date.parse('2026-10-06T08:00:00Z') + (rows.running_quiet_minutes + 5) * 60_000);
  await tell.report({ key: 'export', kind: slow.id, title: 'Making your video' });
  assert.deepEqual(sent.filter(item => item.channel === channel).at(-1).board.map(item => item.title), ['Making your video', 'Waiting on you: 1']);
});

test('a kind that reaches every channel reaches one added later too, less the ones it leaves out', () => {
  const channels = [...rows.channels, { id: 'a-surface-nobody-has-yet', label: 'New', sender: 'kept-list' }];
  const needsYou = rows.kinds.find(row => row.id === 'needs-you');
  assert.ok(kindChannels(needsYou, channels).includes('a-surface-nobody-has-yet'));
  assert.ok(kindChannels(needsYou, channels).includes('mac-app'));
  assert.ok(!kindChannels(needsYou, channels).includes('phone-live'));
});

// Sam 2026-10-06, in their kitchen, heard Trillion ping and could not hear what it wanted: a notice reaches the person
// where they are (the device they are at), a chat's replies are one thread, and an answer said out loud is the
// notice's own answer.
test('a reach_now kind leaves out the phone while the person is at their computer, and only while that report is fresh', async () => {
  const clock = { at: new Date('2026-10-06T21:00:00Z') };
  const here = { device: 'computer', present: 'here', at: '2026-10-06T20:58:00Z' };
  const atDesk = owner({ clock, presence: () => [here] });
  const told = await atDesk.tell.tell({ kind: 'needs-you', title: 'Which price?', key: 'ask-1' });
  const by = Object.fromEntries(told.channels.map(item => [item.channel, item]));
  assert.equal(by.phone.sent, false);
  assert.equal(by.phone.said, rows.reach_now.rules[0].said);
  assert.equal(by['mac-voice'].sent, true, 'the computer still carries it, spoken when the person is away from the keys');
  assert.ok(!atDesk.sent.some(item => item.channel === 'phone'));
  const stale = owner({ clock, presence: () => [{ ...here, at: '2026-10-06T20:00:00Z' }] });
  await stale.tell.tell({ kind: 'needs-you', title: 'Which price?', key: 'ask-2' });
  assert.ok(stale.sent.some(item => item.channel === 'phone'), 'a report older than fresh_minutes says nothing');
  const away = owner({ clock, presence: () => [{ ...here, present: 'away' }] });
  await away.tell.tell({ kind: 'needs-you', title: 'Which price?', key: 'ask-3' });
  assert.ok(away.sent.some(item => item.channel === 'phone'));
  const plain = owner({ clock, presence: () => [here] });
  await plain.tell.tell({ kind: 'video-made', title: 'A video', refs: { file: '1f:a' }, key: 'v1' });
  assert.ok(plain.sent.some(item => item.channel === 'phone'), 'a kind without reach_now goes everywhere it goes');
});

test('a chat\'s replies share one thread on every device, and Reply answers that chat', async () => {
  const answered = [];
  const { tell, sent } = owner({ roads: { thread: async ({ notice, text }) => { answered.push({ conversation: notice.refs.conversation_id, text }); return {}; } } });
  const refs = { open: '/messages?conversation=a', conversation: 'ai:Claude Code:claude-code:s1', app: 'Claude Code', conversation_id: 'claude-code:s1' };
  await tell.tell({ kind: 'ai-reply', title: 'Claude Code replied', body: 'Done.', refs, key: 'ai-reply:m1' });
  await tell.tell({ kind: 'ai-reply', title: 'Claude Code replied', body: 'Also this.', refs, key: 'ai-reply:m2' });
  const shown = sent.filter(item => item.channel === 'phone').map(item => item.shown);
  assert.equal(shown.length, 2);
  assert.ok(shown.every(item => item.group === refs.conversation), 'both carry the one thread');
  assert.deepEqual(shown[0].actions.map(action => action.id), ['answer', 'open']);
  const done = await tell.act({ id: shown[1].id, action: 'answer', text: 'Ship it' });
  assert.equal(done.done, true);
  assert.deepEqual(answered, [{ conversation: 'claude-code:s1', text: 'Ship it' }]);
});

test('an answer said out loud: later leaves it waiting, stop turns speaking off, anything else answers it', async () => {
  const replies = [];
  const { tell, notices } = owner({ roads: { reply: async ({ text }) => { replies.push(text); return {}; } } });
  await tell.tell({ kind: 'needs-you', title: 'Which price for the shelf test?', key: 'ask-9' });
  const id = `told:${notices().at(-1).seq}`;
  assert.equal((await tell.answerAloud({ id, text: 'Later.' })).did, 'later');
  assert.equal(notices().at(-1).read, undefined, 'still waiting to be asked again');
  assert.deepEqual(replies, []);
  const answered = await tell.answerAloud({ id, text: 'Go with five dollars' });
  assert.equal(answered.did, 'answered');
  assert.deepEqual(replies, ['Go with five dollars']);
  await tell.tell({ kind: 'needs-you', title: 'Another question', key: 'ask-10' });
  const stopped = await tell.answerAloud({ id: `told:${notices().at(-1).seq}`, text: 'Okay, stop talking' });
  assert.equal(stopped.did, 'stop');
  assert.ok(notices().filter(item => item.results[rows.spoken_answers.channel]).every(item => item.read), 'nothing spoken is asked again');
  assert.equal((await tell.settings()).channels.find(row => row.id === rows.spoken_answers.channel).on, false);
});

test('a notice about one waiting thing offers Answer, and words said to it go through that thing\'s own finish', async () => {
  const finished = [];
  const { tell, notices } = owner({ roads: { finish: async ({ notice, text }) => { finished.push([notice.refs.card, text]); return { said: 'Done.' }; }, reply: async () => { throw new Error('not this road'); } } });
  await tell.tell({ kind: 'needs-you', title: 'Waiting on you: 2', key: 'nudge-1', refs: { open: '/lists/waiting-on-you/r1', card: 'list:r1' }, open: '/lists/waiting-on-you/r1' });
  const about = notices().at(-1);
  const [shown] = tell.forDevice({ channel: 'mac-app' }).notices.filter(item => item.id === `told:${about.seq}`);
  assert.equal(shown.actions[0].id, 'finish', 'the thing\'s own finish comes first');
  const answered = await tell.answerAloud({ id: `told:${about.seq}`, text: 'Done' });
  assert.deepEqual([answered.did, answered.action], ['answered', 'finish']);
  assert.deepEqual(finished, [['list:r1', 'Done']]);
  await tell.tell({ kind: 'needs-you', title: 'A question with no waiting thing', key: 'ask-11' });
  const plain = notices().at(-1);
  await assert.rejects(tell.act({ id: `told:${plain.seq}`, action: 'finish', text: 'done' }), /not|offer/i, 'a notice about nothing waiting offers no Finish');
});

test('every channel says what it can do, and every device route says what device it is', () => {
  for (const row of rows.channels) assert.ok(Array.isArray(row.can) && row.can.length, `${row.id} says what it can do`);
  assert.ok(rows.channels.some(row => row.can.includes('speak') && row.can.includes('hear-answer')), 'some way speaks and hears the answer');
  for (const route of rows.devices.routes) assert.ok(route.device, `${route.id} says its device`);
  for (const rule of rows.reach_now.rules) for (const device of rule.skip_devices) assert.ok(rows.channels.some(row => row.device === device));
});

test('a device says whether the person is at it, and the newest report is what presence reads', () => {
  let kept = [];
  const clock = { at: new Date('2026-10-06T21:00:00Z') };
  const devices = tellDevices({ read: () => kept, write: list => { kept = list; } }, { routes: rows.devices.routes, present: rows.devices.present, now: () => clock.at });
  devices.add({ route: 'live', address: 'MAC-ADDRESS-1', label: 'Trillion for Mac', present: 'here' });
  assert.deepEqual(devices.presence(), [{ device: 'computer', present: 'here', at: '2026-10-06T21:00:00.000Z' }]);
  clock.at = new Date('2026-10-06T21:05:00Z');
  devices.add({ route: 'live', address: 'MAC-ADDRESS-1', label: 'Trillion for Mac' });
  assert.equal(devices.presence()[0].at, '2026-10-06T21:00:00.000Z', 'registering without a word keeps the last report');
  devices.add({ route: 'live', address: 'MAC-ADDRESS-1', label: 'Trillion for Mac', present: 'away' });
  assert.deepEqual(devices.presence(), [{ device: 'computer', present: 'away', at: '2026-10-06T21:05:00.000Z' }]);
  devices.add({ route: 'live', address: 'MAC-ADDRESS-1', label: 'Trillion for Mac', present: 'asleep' });
  assert.equal(devices.presence()[0].present, 'away', 'a word the rows do not list is not kept');
  assert.equal(devices.listed().length, 1);
});

test('a flood of one kind never takes away the newest notices of another, and the told list stays bounded (invariant 18)', async () => {
  const { tell, notices } = owner();
  await tell.tell({ kind: 'take-me-there', title: 'Check the proof file', key: 'held:one', refs: { card: 'asks:one' } });
  for (let n = 0; n < rows.keep + 100; n++) await tell.tell({ kind: 'ai-reply', title: `Reply ${n}`, key: `reply:${n}` });
  const held = tell.told({ kind: 'take-me-there' }).notices;
  assert.equal(held.length, 1, 'the one take-me-there notice is still kept after the flood');
  assert.equal(held[0].title, 'Check the proof file');
  const kinds = new Set(notices().map(item => item.kind));
  assert.ok(notices().length <= rows.keep + kinds.size * rows.keep_each_kind, 'the list stays bounded');
  assert.equal(notices().filter(item => item.kind === 'ai-reply').length, rows.keep, 'the flooding kind keeps only the newest keep');
  assert.equal(notices().at(-1).title, `Reply ${rows.keep + 99}`, 'the newest is kept, oldest first');
});

test('a notice that arrives in the person\'s quiet hours is shown passively only when that row is turned on (it is off by default)', async () => {
  assert.equal(JSON.parse(readFileSync(new URL('../read-data/tell-quiet-hours.json', import.meta.url), 'utf8')).enabled, false, 'shipped off');
  const levelOf = async options => {
    const { tell, sent } = owner(options);
    await tell.tell({ kind: 'needs-you-request', key: `quiet:${Math.random()}`, title: 'Ping', refs: { card: 'asks:x' } });
    return [...new Set(sent.map(item => item.shown?.level))];
  };
  const usual = await levelOf({});
  assert.deepEqual(await levelOf({ quietNow: () => true }), usual, 'quiet hours alone change nothing while the flag is off');
  assert.deepEqual(await levelOf({ quietNow: () => true, quietRow: { enabled: true, level: 'passive' } }), ['passive']);
  assert.deepEqual(await levelOf({ quietNow: () => false, quietRow: { enabled: true, level: 'passive' } }), usual, 'outside quiet hours the kind\'s own level stands');
});

test('a service notice told on every channel is not narrowed by the person\'s (or an AI\'s) choices; the step an AI runs cannot ask for that', async () => {
  const sent = [];
  const sender = { state: () => ({ ready: true }), send: row => { sent.push(row.id); return { sent: true, said: 'sent' }; } };
  let choices = null, notices = [];
  const tell = makeTellThePerson({ rows, senders: Object.fromEntries([...new Set(rows.channels.map(row => row.sender))].map(name => [name, sender])),
    shows: async () => ({ silenced: true, rules: [{ label: 'Silence everything' }] }), now: () => new Date('2026-10-27T12:00:00Z'),
    store: { choices: () => choices, putChoices: value => { choices = structuredClone(value); }, notices: () => notices, putNotices: list => { notices = structuredClone(list); } } });
  const every = rows.channels.filter(row => !row.while_running && row.on_by_default !== false).map(row => row.id);
  await tell.choose({ kinds: { 'needs-you-request': ['in-app'] }, channels: Object.fromEntries(every.map(id => [id, { on: false }])) });
  await tell.tell({ kind: 'needs-you-request', key: 'passkey-added:k', title: 'A new passkey was added to your Trillion account' }, { everyChannel: true });
  assert.deepEqual(sent.sort(), [...every].sort());
  // The same notice from the step any AI or rule runs follows the person's choices and rules, whatever its input says.
  sent.length = 0;
  await tell.tell({ kind: 'needs-you-request', key: 'other', title: 'Hello', every_channel: true, everyChannel: true });
  assert.deepEqual(sent, []);
});
