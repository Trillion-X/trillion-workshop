// Every service pulled against a stand-in that answers in the shape the service documents, with the person's records door
// holding exactly the rights the pull rows declare. The people and places are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pullFromAnAccount } from '../do-work/pull.mjs';
import { assemble, readParts, stateId, threadId, itemId } from '../read-data/snapshot.mjs';
import { fakeService, openDoor, waits } from './service.mjs';

const TOKEN = 'tok-9f2c1e77aa41';
const NOW = '2026-10-30T12:00:00Z';
const json = body => ({ body });

async function pull(source, input, service, opened, extra = {}) {
  return pullFromAnAccount(source, input, { token: TOKEN, fetch: service.fetch, door: opened.door, now: () => NOW, wait: async () => {}, ...extra });
}
const snapshotOf = async (opened, source, account = 'default') => assemble(source, account, await readParts(opened.door, source, account));
const calls = (service, ending) => service.calls.filter(call => call.path.endsWith(ending));

// ---- Discord -------------------------------------------------------------------------------------------------------

const post = (id, text, extra = {}) => ({ id, content: text, timestamp: '2026-10-01T10:00:00.000000+00:00', edited_timestamp: null, author: { id: '5001', username: 'ana' }, ...extra });
function discord({ orders = [post('1200000000000000003', 'Two rye loaves'), post('1200000000000000001', 'Do you have sourdough?')], news = [post('1200000000000000007', 'Closed Monday')], refuse = [], name = 'orders' } = {}) {
  return fakeService(url => {
    const p = url.pathname.replace('/api/v10', '');
    if (p === '/users/@me') return json({ id: '900000000000000001', username: 'bakery-bot', bot: true });
    if (p === '/users/@me/guilds') return json([{ id: 'g1', name: 'Rolling Pin Bakery' }]);
    if (p === '/guilds/g1/channels') return json([{ id: 'c-orders', name, type: 0 }, { id: 'c-voice', name: 'chat-voice', type: 2 }, { id: 'c-news', name: 'news', type: 5 }]);
    const channel = /^\/channels\/(.+)\/messages$/.exec(p)?.[1];
    if (refuse.includes(channel)) return { status: 403, body: { message: 'Missing Access', code: 50001 } };
    if (channel === 'c-orders') return json(url.searchParams.get('before') ? [] : orders);
    if (channel === 'c-news') return json(url.searchParams.get('before') ? [] : news);
    return { status: 404, body: { message: 'Unknown' } };
  });
}

test('discord: text and announcement channels are pulled with the bot header, kept as the service sent them, oldest first', async () => {
  const opened = await openDoor();
  const service = discord();
  const done = await pull('discord', {}, service, opened);
  assert.equal(done.status, 'pulled');
  assert.equal(done.self_id, '900000000000000001');
  assert.deepEqual([done.threads, done.new_messages], [2, 3]);
  assert.equal(calls(service, '/messages').length, 2);
  assert.equal(service.calls[0].headers.Authorization, `Bot ${TOKEN}`);
  assert.match(service.calls[0].headers['User-Agent'], /^DiscordBot \(https:\/\/.+, 1\.0\)$/);
  assert.equal(calls(service, '/messages')[0].query.limit, '50');
  const snapshot = await snapshotOf(opened, 'discord');
  assert.deepEqual(snapshot.threads.map(thread => thread.id), ['c-orders', 'c-news']);
  assert.equal(snapshot.threads[0].title, '#orders — Rolling Pin Bakery');
  assert.deepEqual(snapshot.threads[0].messages.map(message => message.id), ['1200000000000000001', '1200000000000000003']);
  assert.equal(snapshot.threads[0].messages[1].author.username, 'ana');
  assert.equal(snapshot.self_id, '900000000000000001');
});

test('discord: pulling again keeps everything once, writes only the state, and a later edit replaces the older copy', async () => {
  const opened = await openDoor();
  await pull('discord', {}, discord(), opened);
  const writesBefore = opened.calls.filter(call => call.method === 'records:write').length;
  const again = await pull('discord', {}, discord(), opened);
  assert.equal(again.new_messages, 0);
  const writes = opened.calls.filter(call => call.method === 'records:write').slice(writesBefore);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].input.records.map(record => record.id), [stateId('discord', 'default')]);

  const edited = discord({ orders: [post('1200000000000000003', 'Two rye loaves, sliced', { edited_timestamp: '2026-10-02T09:00:00.000000+00:00' }), post('1200000000000000001', 'Do you have sourdough?')] });
  assert.equal((await pull('discord', {}, edited, opened)).new_messages, 0);
  const messages = (await snapshotOf(opened, 'discord')).threads[0].messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, 'Two rye loaves, sliced');
});

test('discord: a renamed channel takes its new title and keeps its history', async () => {
  const opened = await openDoor();
  await pull('discord', {}, discord(), opened);
  await pull('discord', {}, discord({ orders: [], name: 'bread-orders' }), opened);
  const thread = (await snapshotOf(opened, 'discord')).threads[0];
  assert.equal(thread.title, '#bread-orders — Rolling Pin Bakery');
  assert.equal(thread.messages.length, 2);
});

test('discord: a channel the bot may not read is named in errors and the others are still kept', async () => {
  const opened = await openDoor();
  const done = await pull('discord', {}, discord({ refuse: ['c-orders'] }), opened);
  assert.equal(done.status, 'partial');
  assert.equal(done.errors.length, 1);
  assert.match(done.errors[0], /Missing Access \(HTTP 403\)/);
  assert.deepEqual((await snapshotOf(opened, 'discord')).threads.map(thread => thread.id), ['c-news']);
});

test('discord: one 429 is waited out for the time the service names and tried again; a second one is an error', async () => {
  const opened = await openDoor();
  let limited = 0;
  const service = fakeService(url => {
    if (url.pathname.endsWith('/users/@me')) return json({ id: '9' });
    if (url.pathname.endsWith('/guilds')) return json([{ id: 'g1', name: 'G' }]);
    if (url.pathname.endsWith('/channels')) return json([{ id: 'c1', name: 'one', type: 0 }]);
    limited += 1;
    return limited <= 1 ? { status: 429, body: { retry_after: 2.5 } } : json([post('11', 'hello')]);
  });
  const asked = waits();
  assert.equal((await pull('discord', {}, service, opened, { wait: asked.wait })).new_messages, 1);
  assert.deepEqual(asked.asked, [2500]);

  const stubborn = fakeService(url => {
    if (url.pathname.endsWith('/users/@me')) return json({ id: '9' });
    if (url.pathname.endsWith('/guilds')) return json([{ id: 'g1', name: 'G' }]);
    if (url.pathname.endsWith('/channels')) return json([{ id: 'c1', name: 'one', type: 0 }]);
    return { status: 429, body: { retry_after: 1 } };
  });
  const failed = await pull('discord', {}, stubborn, opened, { wait: asked.wait });
  assert.equal(failed.status, 'partial');
  assert.match(failed.errors[0], /HTTP 429/);
});

test('discord: a full page leads to the next older page, and paging stops at a page that is all held', async () => {
  const opened = await openDoor();
  const pages = { '': [post('30', 'c'), post('29', 'b')], 29: [post('28', 'a'), post('27', 'z')], 27: [post('26', 'y')] };
  const service = fakeService(url => {
    const p = url.pathname;
    if (p.endsWith('/users/@me')) return json({ id: '9' });
    if (p.endsWith('/guilds')) return json([{ id: 'g1', name: 'G' }]);
    if (p.endsWith('/channels')) return json([{ id: 'c1', name: 'one', type: 0 }]);
    return json(pages[url.searchParams.get('before') ?? ''] ?? []);
  });
  const done = await pull('discord', { limit: 2, most_pages: 5 }, service, opened);
  assert.equal(done.new_messages, 5);
  assert.deepEqual(calls(service, '/messages').map(call => call.query.before), [undefined, '29', '27']);
  const second = fakeService(url => {
    const p = url.pathname;
    if (p.endsWith('/users/@me')) return json({ id: '9' });
    if (p.endsWith('/guilds')) return json([{ id: 'g1', name: 'G' }]);
    if (p.endsWith('/channels')) return json([{ id: 'c1', name: 'one', type: 0 }]);
    return json(pages[url.searchParams.get('before') ?? ''] ?? []);
  });
  assert.equal((await pull('discord', { limit: 2, most_pages: 5 }, second, opened)).new_messages, 0);
  assert.equal(calls(second, '/messages').length, 1);
});

// ---- Slack ---------------------------------------------------------------------------------------------------------

const say = (ts, text, extra = {}) => ({ type: 'message', user: 'U1', ts, text, ...extra });
function slack({ history = {}, fail = [], listPages } = {}) {
  return fakeService(url => {
    const p = url.pathname.replace('/api', '');
    if (p === '/auth.test') return json({ ok: true, url: 'https://rolling-pin.example/', user_id: 'U0BOT' });
    if (p === '/conversations.list') {
      if (listPages) return json(listPages[url.searchParams.get('cursor') ?? '']);
      return json({ ok: true, channels: [{ id: 'C1', name: 'orders' }, { id: 'C2', name: 'ovens' }], response_metadata: { next_cursor: '' } });
    }
    const channel = url.searchParams.get('channel');
    if (fail.includes(channel)) return json({ ok: false, error: 'channel_not_found' });
    return json({ ok: true, messages: history[channel] ?? [], has_more: false });
  });
}

test('slack: channels the bot is in are pulled and the next pull asks only for what is newer than the newest message seen', async () => {
  const opened = await openDoor();
  const history = { C1: [say('1700000200.000300', 'Ready at noon'), say('1700000100.000100', 'Order for Friday')], C2: [say('1700000150.000200', 'Oven 2 is warm')] };
  const first = slack({ history });
  const done = await pull('slack', {}, first, opened);
  assert.equal(done.status, 'pulled');
  assert.equal(done.self_id, 'U0BOT');
  assert.equal(done.new_messages, 3);
  assert.equal(done.cursor, '1700000200.000300');
  assert.deepEqual(calls(first, '/conversations.history').map(call => call.query.oldest), ['0', '0']);
  assert.equal(first.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  const snapshot = await snapshotOf(opened, 'slack');
  assert.deepEqual(snapshot.threads.map(thread => [thread.id, thread.title, thread.messages.map(message => message.ts)]), [['C1', 'orders', ['1700000100.000100', '1700000200.000300']], ['C2', 'ovens', ['1700000150.000200']]]);

  const second = slack({ history: { C1: [say('1700000200.000300', 'Ready at noon')] } });
  await pull('slack', {}, second, opened);
  assert.deepEqual(calls(second, '/conversations.history').map(call => call.query.oldest), ['1700000200.000300', '1700000200.000300']);
  assert.equal((await snapshotOf(opened, 'slack')).cursor, '1700000200.000300');
});

test('slack: an older batch never moves the cursor back, and a message edited later replaces the older copy', async () => {
  const opened = await openDoor();
  await pull('slack', {}, slack({ history: { C1: [say('1700000200.000300', 'Ready at noon')] } }), opened);
  const stale = await pull('slack', {}, slack({ history: { C1: [say('1700000100.000100', 'older')] } }), opened);
  assert.equal(stale.cursor, '1700000200.000300');
  await pull('slack', {}, slack({ history: { C1: [say('1700000200.000300', 'Ready at one', { edited: { user: 'U1', ts: '1700000300.000000' } })] } }), opened);
  const messages = (await snapshotOf(opened, 'slack')).threads[0].messages;
  assert.deepEqual(messages.map(message => message.text), ['older', 'Ready at one']);
});

test('slack: when one channel fails the others are kept but the cursor does not move, so the failed one is read again', async () => {
  const opened = await openDoor();
  const done = await pull('slack', {}, slack({ history: { C1: [say('1700000200.000300', 'Ready')] }, fail: ['C2'] }), opened);
  assert.equal(done.status, 'partial');
  assert.match(done.errors[0], /channel_not_found/);
  assert.equal(done.cursor, '0');
  assert.deepEqual((await snapshotOf(opened, 'slack')).threads.map(thread => thread.id), ['C1']);
});

test('slack: a conversation with more pages than most_pages leaves the cursor where it was, and a pull that reads them all moves it', async () => {
  const opened = await openDoor();
  const pages = { '': { ok: true, messages: [say('1700000300.000100', 'newest')], has_more: true, response_metadata: { next_cursor: 'p2' } }, p2: { ok: true, messages: [say('1700000200.000100', 'older')], has_more: false } };
  const service = () => fakeService(url => {
    const p = url.pathname.replace('/api', '');
    if (p === '/auth.test') return json({ ok: true, user_id: 'U0BOT' });
    if (p === '/conversations.list') return json({ ok: true, channels: [{ id: 'C1', name: 'orders' }] });
    return json(pages[url.searchParams.get('cursor') ?? '']);
  });
  const cut = await pull('slack', { most_pages: 1 }, service(), opened);
  assert.equal(cut.status, 'partial');
  assert.match(cut.errors[0], /more pages than most_pages \(1\); raise most_pages to read them\. The cursor did not move/);
  assert.equal(cut.cursor, '0');
  assert.equal((await snapshotOf(opened, 'slack')).threads[0].messages.length, 1);
  const whole = await pull('slack', { most_pages: 2 }, service(), opened);
  assert.deepEqual([whole.status, whole.cursor, whole.new_messages], ['pulled', '1700000300.000100', 1]);
  assert.deepEqual((await snapshotOf(opened, 'slack')).threads[0].messages.map(message => message.text), ['older', 'newest']);
});

test('slack: the channel list is followed page by page', async () => {
  const opened = await openDoor();
  const service = slack({
    history: { C1: [say('1700000100.000100', 'a')], C3: [say('1700000110.000100', 'c')] },
    listPages: {
      '': { ok: true, channels: [{ id: 'C1', name: 'orders' }], response_metadata: { next_cursor: 'dGVhbQ==' } },
      dGVhbQ: { ok: true, channels: [{ id: 'C3', name: 'staff' }], response_metadata: { next_cursor: '' } },
      'dGVhbQ==': { ok: true, channels: [{ id: 'C3', name: 'staff' }], response_metadata: { next_cursor: '' } },
    },
  });
  await pull('slack', {}, service, opened);
  assert.deepEqual((await snapshotOf(opened, 'slack')).threads.map(thread => thread.id), ['C1', 'C3']);
});

test('slack: an answer of ok false at the identity call is a login problem, and nothing is read or written', async () => {
  const opened = await openDoor();
  const service = fakeService(() => json({ ok: false, error: 'invalid_auth' }));
  const done = await pull('slack', {}, service, opened);
  assert.equal(done.status, 'needs_login');
  assert.match(done.errors[0], /invalid_auth/);
  assert.equal(service.calls.length, 1);
  assert.equal(opened.calls.length, 0);
});

// ---- Telegram ------------------------------------------------------------------------------------------------------

const chat = (id, extra = {}) => ({ id, type: 'supergroup', ...extra });
const said = (message_id, text, to, extra = {}) => ({ message_id, date: 1760000000 + message_id, chat: to, from: { id: 5001, first_name: 'Ana' }, text, ...extra });
function telegram(updates, { status = 200, body } = {}) {
  return fakeService(url => {
    const p = url.pathname.replace(`/bot${TOKEN}`, '');
    if (p === '/getMe') return json({ ok: true, result: { id: 4242, is_bot: true, first_name: 'Bakery bot' } });
    if (p === '/getUpdates') return body ? { status, body } : json({ ok: true, result: updates });
    return { status: 404, body: { ok: false, description: 'Not Found' } };
  });
}

test('telegram: the token is in the path and nowhere else, all four message kinds are kept by chat, and the offset moves past every update', async () => {
  const opened = await openDoor();
  const group = chat(-1001, { title: 'Bakers' });
  const updates = [
    { update_id: 10, message: said(1, 'Rye is ready', group) },
    { update_id: 11, edited_message: said(1, 'Rye is ready at ten', group, { edit_date: 1760000500 }) },
    { update_id: 12, channel_post: said(5, 'Closed Monday', chat(-2002, { type: 'channel', title: 'News' })) },
    { update_id: 13, edited_channel_post: said(5, 'Closed Monday and Tuesday', chat(-2002, { type: 'channel', title: 'News' }), { edit_date: 1760000600 }) },
    { update_id: 14, my_chat_member: { chat: group } },
  ];
  const service = telegram(updates);
  const done = await pull('telegram', {}, service, opened);
  assert.equal(done.status, 'pulled');
  assert.equal(done.self_id, '4242');
  assert.equal(done.cursor, 15);
  assert.equal(service.calls[0].path, `/bot${TOKEN}/getMe`);
  assert.equal(service.calls[1].query.offset, '0');
  assert.equal(Object.keys(service.calls[0].headers).some(name => /authorization/i.test(name)), false);
  const snapshot = await snapshotOf(opened, 'telegram');
  assert.deepEqual(snapshot.threads.map(thread => [thread.id, thread.title, thread.messages.map(message => message.text)]), [['-1001', 'Bakers', ['Rye is ready at ten']], ['-2002', 'News', ['Closed Monday and Tuesday']]]);
  assert.equal(JSON.stringify([done, opened.calls.map(call => call.input)]).includes(TOKEN), false);

  const next = telegram([]);
  await pull('telegram', {}, next, opened);
  assert.equal(next.calls[1].query.offset, '15');
});

test('telegram: a chat is titled by its name, else the person\'s name, else their handle, else its id', async () => {
  const opened = await openDoor();
  const updates = [
    { update_id: 1, message: said(1, 'a', chat(-1, { title: 'Bakers' })) },
    { update_id: 2, message: said(1, 'b', { id: 7, type: 'private', first_name: 'Ana', last_name: 'Lopez' }) },
    { update_id: 3, message: said(1, 'c', { id: 8, type: 'private', username: 'ana_l' }) },
    { update_id: 4, message: said(1, 'd', { id: 9, type: 'private' }) },
    { update_id: 5, message: { message_id: 2, date: 1, text: 'no chat' } },
  ];
  await pull('telegram', {}, telegram(updates), opened);
  assert.deepEqual((await snapshotOf(opened, 'telegram')).threads.map(thread => thread.title), ['Bakers', 'Ana Lopez', '@ana_l', '9']);
});

test('telegram: a refusal from Telegram is named without the token and the offset stays where it was', async () => {
  const opened = await openDoor();
  const service = telegram([], { status: 409, body: { ok: false, error_code: 409, description: `Conflict: terminated by other getUpdates request for ${TOKEN}` } });
  const done = await pull('telegram', {}, service, opened);
  assert.equal(done.status, 'partial');
  assert.match(done.errors[0], /Conflict: terminated by other getUpdates request/);
  assert.equal(JSON.stringify(done).includes(TOKEN), false);
  assert.equal(done.cursor, '0');
});

test('telegram: a token Telegram does not know is a login problem', async () => {
  const opened = await openDoor();
  const service = fakeService(() => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }));
  const done = await pull('telegram', {}, service, opened);
  assert.equal(done.status, 'needs_login');
  assert.equal(opened.calls.length, 0);
});

// ---- Signal (handed the client's printed output, nothing is asked) -----------------------------------------------------

const ME = 'acct-a';
const sent = (id, timestamp, from, body, extra = {}) => ({ id, timestamp, from, type: 'normal', body, ...extra });
const printed = (messages, extra = {}) => [{ id: 'thread-1', name: 'Bakers', type: 'group', messages, ...extra }];
const handed = (opened, conversations, extra = {}) => {
  const service = fakeService(() => new Error('nothing is asked of a service'));
  return pullFromAnAccount('signal', { self_id: ME, conversations, ...extra }, { fetch: service.fetch, door: opened.door, now: () => NOW }).then(done => ({ done, service }));
};

test('signal: the printed conversations are kept as printed in time order, with the account\'s own messages named by self_id, and nothing is asked of any service', async () => {
  const opened = await openDoor();
  const messages = [sent('m2', 1700000001000, ME, 'On my way'), sent('m1', 1700000000000, 'acct-b', 'Rye is ready'), { id: 'm3', timestamp: 1700000002000, from: 'acct-b', type: 'call_started' }];
  const { done, service } = await handed(opened, printed(messages));
  assert.equal(done.status, 'pulled');
  assert.equal(done.self_id, ME);
  assert.equal(done.new_messages, 3);
  assert.equal(done.cursor, 1700000002000);
  assert.equal(service.calls.length, 0);
  const snapshot = await snapshotOf(opened, 'signal');
  assert.equal(snapshot.self_id, ME);
  assert.deepEqual(snapshot.threads.map(thread => [thread.id, thread.title, thread.messages.map(message => message.id)]), [['thread-1', 'Bakers', ['m1', 'm2', 'm3']]]);
  assert.deepEqual(snapshot.threads[0].messages[1], messages[0]);
});

test('signal: a conversation is titled by its name, else its id, and a message without an id is known by its time', async () => {
  const opened = await openDoor();
  const { done } = await handed(opened, [
    { id: 'thread-1', messages: [{ timestamp: 1700000000000, from: 'acct-b', body: 'a' }] },
    { id: 'thread-2', name: 'Orders', messages: [sent('x', 1, 'acct-b', 'b')] },
  ]);
  assert.equal(done.status, 'pulled');
  const snapshot = await snapshotOf(opened, 'signal');
  assert.deepEqual(snapshot.threads.map(thread => thread.title), ['thread-1', 'Orders']);
  assert.equal(snapshot.threads[0].messages.length, 1);
});

test('signal: the same output handed again adds nothing and writes only the state; a later edit replaces the older copy and an older edit never replaces a later one', async () => {
  const opened = await openDoor();
  const first = printed([sent('m1', 1700000000000, 'acct-b', 'Rye is ready')]);
  await handed(opened, first);
  const writesBefore = opened.calls.filter(call => call.method === 'records:write').length;
  const again = await handed(opened, first);
  assert.equal(again.done.new_messages, 0);
  const writes = opened.calls.filter(call => call.method === 'records:write').slice(writesBefore);
  assert.deepEqual(writes.map(write => write.input.records.map(record => record.id)), [[stateId('signal', 'default')]]);

  const edited = printed([sent('m1', 1700000000000, 'acct-b', 'Rye is ready at ten', { editedTimestamp: 1700000500000 })]);
  const later = await handed(opened, edited);
  assert.equal(later.done.new_messages, 0);
  assert.equal((await snapshotOf(opened, 'signal')).threads[0].messages[0].body, 'Rye is ready at ten');
  await handed(opened, printed([sent('m1', 1700000000000, 'acct-b', 'Rye is ready at nine', { editedTimestamp: 1700000100000 })]));
  assert.equal((await snapshotOf(opened, 'signal')).threads[0].messages[0].body, 'Rye is ready at ten');
});

test('signal: the cursor is the greatest message time seen and never moves back, and history already kept is never lost', async () => {
  const opened = await openDoor();
  await handed(opened, printed([sent('m1', 1700000000000, 'acct-b', 'a'), sent('m2', 1700000003000, 'acct-b', 'b')]));
  const older = await handed(opened, printed([sent('m0', 1699999999000, 'acct-b', 'earlier')], { name: 'Bakers and friends' }));
  assert.equal(older.done.cursor, 1700000003000);
  const snapshot = await snapshotOf(opened, 'signal');
  assert.deepEqual(snapshot.threads[0].messages.map(message => message.id), ['m0', 'm1', 'm2']);
  assert.equal(snapshot.threads[0].title, 'Bakers and friends');
});

test('signal: what cannot be kept is named in skipped with its conversation and why, and the others are kept', async () => {
  const opened = await openDoor();
  const { done } = await handed(opened, [
    ...printed([{ from: 'acct-b', body: 'no id, no time' }, { from: 'acct-b', body: 'nor this' }, sent('m1', 1700000000000, 'acct-b', 'kept')]),
    { name: 'Orders', messages: [sent('m9', 5, 'acct-b', 'lost'), sent('m10', 6, 'acct-b', 'lost too')] },
    { messages: [sent('m11', 7, 'acct-b', 'lost')] },
    { id: 'thread-3', name: 'empty', messages: [] },
  ]);
  assert.equal(done.status, 'pulled');
  assert.equal(done.new_messages, 1);
  assert.deepEqual(done.skipped, [
    { conversation: 'Orders', reason: '2 messages left out: the conversation has no id' },
    { conversation: 'conversation 3', reason: '1 message left out: the conversation has no id' },
    { conversation: 'thread-1', reason: '2 messages left out: they have none of /id, /timestamp to tell them by' },
  ]);
  assert.match(done.said, /3 left out \(see skipped\)/);
  assert.deepEqual((await snapshotOf(opened, 'signal')).threads.map(thread => thread.id), ['thread-1']);
});

test('a pull that leaves nothing out says skipped is empty', async () => {
  const opened = await openDoor();
  const { done } = await handed(opened, printed([sent('m1', 1, 'acct-b', 'a')]));
  assert.deepEqual(done.skipped, []);
  assert.doesNotMatch(done.said, /left out/);
});

// The contract the Signal client's row is built to match: test/fixtures/signal-client-output.json is a made-up output in
// exactly that shape, and the README's "What the Signal client must hand in" table lists the same fields.
const CONVERSATION_FIELDS = new Set(['id', 'name', 'type', 'messages']);
const MESSAGE_FIELDS = new Set(['id', 'timestamp', 'from', 'body', 'editedTimestamp', 'type']);

test('signal: the fixture of the client\'s output holds only the contract\'s fields, is pulled whole with nothing left out, and reads as the contract says', async () => {
  const output = JSON.parse(readFileSync(new URL('./fixtures/signal-client-output.json', import.meta.url), 'utf8'));
  for (const conversation of output) {
    assert.ok(Object.keys(conversation).every(key => CONVERSATION_FIELDS.has(key)));
    assert.ok(Array.isArray(conversation.messages));
    for (const message of conversation.messages) {
      assert.ok(Object.keys(message).every(key => MESSAGE_FIELDS.has(key)));
      assert.ok(Number.isInteger(message.timestamp) && message.timestamp > 1e12, 'timestamp is epoch milliseconds');
      assert.equal(typeof message.from, 'string');
    }
  }
  const opened = await openDoor();
  const { done } = await handed(opened, output);
  assert.equal(done.status, 'pulled');
  assert.deepEqual(done.skipped, []);
  assert.equal(done.new_messages, 5);
  assert.equal(done.cursor, 1700000004000);
  const snapshot = await snapshotOf(opened, 'signal');
  assert.deepEqual(snapshot.threads.map(thread => [thread.id, thread.title]), [['thread-1', 'Bakers'], ['thread-2', 'thread-2']]);
  assert.deepEqual(snapshot.threads[1].messages, output[1].messages);
  assert.deepEqual(snapshot.threads[0].messages, output[0].messages);
});

test('signal: the accounts are kept apart and at most most_threads conversations are read', async () => {
  const opened = await openDoor();
  const conversations = [1, 2, 3].map(number => ({ id: `thread-${number}`, messages: [sent('m', number, 'acct-b', 'x')] }));
  const { done } = await handed(opened, conversations, { most_threads: 2 });
  assert.equal(done.threads, 2);
  await handed(opened, printed([sent('m1', 1700000000000, 'acct-b', 'work')]), { account: 'work' });
  assert.equal((await snapshotOf(opened, 'signal', 'work')).threads.length, 1);
  assert.equal((await snapshotOf(opened, 'signal')).threads.length, 2);
});

test('signal: a document that is not a list, or no self_id, is refused with what to give, and nothing is written', async () => {
  const opened = await openDoor();
  await assert.rejects(handed(opened, { threads: [] }), /conversations is the whole list of conversations that Signal printed/);
  await assert.rejects(pullFromAnAccount('signal', { conversations: [] }, { door: opened.door }), /self_id is the identity of the account/);
  assert.equal(opened.calls.length, 0);
});

// ---- Instagram and Messenger ---------------------------------------------------------------------------------------

const conversation = (id, others) => ({ id, updated_time: '2026-10-02T10:00:00+0000', participants: { data: [{ id: '900', username: 'rolling_pin' }, ...others] } });
const dm = (id, text, at = '2026-10-01T10:00:00+0000') => ({ id, from: { id: '55', username: 'ana' }, created_time: at, message: text });
function meta({ conversations, messages, transportFailures = 0 } = {}) {
  let failures = transportFailures;
  return fakeService(url => {
    const p = url.pathname.replace('/v21.0', '');
    if (p === '/me') return json({ id: '900', user_id: '900', username: 'rolling_pin', name: 'Rolling Pin' });
    if (p === '/me/conversations') return json(conversations[url.searchParams.get('after') ?? '']);
    const thread = /^\/(.+)\/messages$/.exec(p)?.[1];
    if (failures > 0) { failures -= 1; return new Error('fetch failed'); }
    return json(messages[thread] ?? { data: [] });
  });
}
const conversations = {
  '': { data: [conversation('t_1', [{ id: '55', username: 'ana' }])], paging: { cursors: { after: 'AFTER1' }, next: 'https://graph.example/next' } },
  AFTER1: { data: [conversation('t_2', [{ id: '56', username: 'ben' }])], paging: { cursors: { after: 'AFTER2' } } },
};
const messages = { t_1: { data: [dm('m_2', 'Rye please', '2026-10-01T10:05:00+0000'), dm('m_1', 'Do you have rye?')] }, t_2: { data: [dm('m_9', 'Hello')] } };

test('instagram: conversations are followed page by page, each message is pulled and each conversation keeps its participants', async () => {
  const opened = await openDoor();
  const service = meta({ conversations, messages });
  const done = await pull('instagram-messages', {}, service, opened);
  assert.equal(done.status, 'pulled');
  assert.equal(done.self_id, '900');
  assert.deepEqual([done.threads, done.new_messages], [2, 3]);
  assert.ok(service.calls.every(call => call.url.host === 'graph.instagram.com'));
  assert.equal(calls(service, '/me/conversations')[0].query.platform, 'instagram');
  assert.equal(calls(service, '/me/conversations')[0].query.fields, 'participants,updated_time');
  assert.equal(service.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  const snapshot = await snapshotOf(opened, 'instagram-messages');
  assert.deepEqual(snapshot.threads.map(thread => thread.id), ['t_1', 't_2']);
  assert.deepEqual(snapshot.threads[0].messages.map(message => message.id), ['m_1', 'm_2']);
  assert.equal(snapshot.threads[0].source.participants.data[1].username, 'ana');
  assert.equal(snapshot.threads[0].messages[0].from.username, 'ana');
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
});

test('instagram: pulling again adds nothing, and the later copy of a message has its fields merged over the earlier one', async () => {
  const opened = await openDoor();
  await pull('instagram-messages', {}, meta({ conversations, messages }), opened);
  const again = await pull('instagram-messages', {}, meta({ conversations, messages: { ...messages, t_1: { data: [{ ...dm('m_2', 'Rye please', '2026-10-01T10:05:00+0000'), reactions: ['love'] }, dm('m_1', 'Do you have rye?')] } } }), opened);
  assert.equal(again.new_messages, 0);
  const held = (await snapshotOf(opened, 'instagram-messages')).threads[0].messages;
  assert.equal(held.length, 2);
  assert.deepEqual(held[1].reactions, ['love']);
});

test('messenger is the same pull on the Facebook host with its own platform', async () => {
  const opened = await openDoor();
  const service = meta({ conversations, messages });
  const done = await pull('messenger-messages', {}, service, opened);
  assert.equal(done.new_messages, 3);
  assert.ok(service.calls.every(call => call.url.host === 'graph.facebook.com'));
  assert.equal(calls(service, '/me/conversations')[0].query.platform, 'messenger');
  assert.equal(service.calls[0].query.fields, 'id,name');
  assert.equal((await snapshotOf(opened, 'messenger-messages')).threads.length, 2);
  assert.equal((await snapshotOf(opened, 'instagram-messages')).threads.length, 0);
});

test('instagram: a connection that drops before an answer is tried again a few times, then named without the token', async () => {
  const opened = await openDoor();
  const flaky = meta({ conversations, messages, transportFailures: 2 });
  const asked = waits();
  const done = await pull('instagram-messages', {}, flaky, opened, { wait: asked.wait });
  assert.equal(done.status, 'pulled');
  assert.deepEqual(asked.asked, [1000, 2000]);

  const dead = fakeService(() => new Error(`connect ECONNRESET for ${TOKEN}`));
  const lost = await pull('instagram-messages', {}, dead, opened, { wait: asked.wait });
  assert.equal(lost.status, 'unreachable');
  assert.equal(dead.calls.length, 4);
  assert.equal(JSON.stringify(lost).includes(TOKEN), false);
});

// ---- X bookmarks ---------------------------------------------------------------------------------------------------

const tweet = id => ({ id, text: `Post ${id}`, author_id: '77', created_at: '2026-10-01T10:00:00.000Z' });
function x(pages) {
  return fakeService(url => {
    const p = url.pathname.replace('/2', '');
    if (p === '/users/me') return json({ data: { id: '2244994945', name: 'Rolling Pin', username: 'rolling_pin' } });
    if (p === '/users/2244994945/bookmarks') return json(pages[url.searchParams.get('pagination_token') ?? '']);
    return { status: 404, body: { title: 'Not Found' } };
  });
}

test('x: bookmarks are pulled page by page into one collection, newest first as the service sends them', async () => {
  const opened = await openDoor();
  const service = x({ '': { data: [tweet('t3'), tweet('t2')], meta: { result_count: 2, next_token: 'NEXT1' } }, NEXT1: { data: [tweet('t1')], meta: { result_count: 1 } } });
  const done = await pull('x-bookmarks', {}, service, opened);
  assert.deepEqual([done.status, done.new_items, done.items, done.threads], ['pulled', 3, 3, 0]);
  assert.equal(service.calls[0].path, '/2/users/me');
  assert.equal(calls(service, '/bookmarks')[0].query.max_results, '100');
  assert.equal(calls(service, '/bookmarks')[1].query.pagination_token, 'NEXT1');
  assert.deepEqual((await snapshotOf(opened, 'x-bookmarks')).collections.bookmarks.map(item => item.id), ['t3', 't2', 't1']);
});

test('x: a pull after the first stops at the first page it already holds, so a new bookmark costs one page', async () => {
  const opened = await openDoor();
  const everything = { '': { data: [tweet('t3'), tweet('t2')], meta: { next_token: 'NEXT1' } }, NEXT1: { data: [tweet('t1')], meta: {} } };
  await pull('x-bookmarks', {}, x(everything), opened);

  const fresh = x({ '': { data: [tweet('t4'), tweet('t3')], meta: { next_token: 'NEXT1' } }, NEXT1: { data: [tweet('t1')], meta: {} } });
  const withNew = await pull('x-bookmarks', {}, fresh, opened);
  assert.equal(withNew.new_items, 1);
  assert.equal(calls(fresh, '/bookmarks').length, 2);

  const quiet = x({ '': { data: [tweet('t4'), tweet('t3')], meta: { next_token: 'NEXT1' } }, NEXT1: { data: [tweet('t1')], meta: {} } });
  const nothing = await pull('x-bookmarks', {}, quiet, opened);
  assert.equal(nothing.new_items, 0);
  assert.equal(calls(quiet, '/bookmarks').length, 1);
  assert.deepEqual((await snapshotOf(opened, 'x-bookmarks')).collections.bookmarks.map(item => item.id), ['t3', 't2', 't1', 't4']);
});

test('x: an account with no bookmarks is not an error, and a token X refuses is a login problem', async () => {
  const opened = await openDoor();
  const none = await pull('x-bookmarks', {}, x({ '': { meta: { result_count: 0 } } }), opened);
  assert.deepEqual([none.status, none.new_items, none.errors], ['pulled', 0, []]);
  const refused = fakeService(() => ({ status: 401, body: { title: 'Unauthorized', detail: 'Unauthorized', status: 401 } }));
  const login = await pull('x-bookmarks', {}, refused, opened);
  assert.equal(login.status, 'needs_login');
  assert.match(login.errors[0], /Unauthorized \(HTTP 401\)/);
});

// ---- Pinterest -----------------------------------------------------------------------------------------------------

function pinterest({ pins, boards }) {
  return fakeService(url => {
    const p = url.pathname.replace('/v5', '');
    if (p === '/user_account') return json({ account_type: 'BUSINESS', username: 'rolling_pin_bakery', pin_count: 3, board_count: 1 });
    if (p === '/pins') return json(pins[url.searchParams.get('bookmark') ?? '']);
    if (p === '/boards') return json(boards[url.searchParams.get('bookmark') ?? '']);
    return { status: 404, body: { code: 1, message: 'Not found' } };
  });
}
const pin = (id, title) => ({ id, title, created_at: '2026-10-01T10:00:00' });

test('pinterest: pins and boards are each followed by their bookmark and kept in their own collection', async () => {
  const opened = await openDoor();
  const service = pinterest({
    pins: { '': { items: [pin('p2', 'Rye'), pin('p1', 'Sourdough')], bookmark: 'B1' }, B1: { items: [pin('p0', 'Focaccia')], bookmark: null } },
    boards: { '': { items: [{ id: 'b1', name: 'Loaves' }], bookmark: null } },
  });
  const done = await pull('pinterest-pins', {}, service, opened);
  assert.deepEqual([done.status, done.self_id, done.new_items, done.items], ['pulled', 'rolling_pin_bakery', 4, 4]);
  assert.equal(calls(service, '/pins')[0].query.page_size, '100');
  assert.equal(calls(service, '/pins')[1].query.bookmark, 'B1');
  const collections = (await snapshotOf(opened, 'pinterest-pins')).collections;
  assert.deepEqual(collections.pins.map(item => item.id), ['p2', 'p1', 'p0']);
  assert.deepEqual(collections.boards.map(item => item.name), ['Loaves']);
});

test('pinterest: a pin pulled again has its fields refreshed, nothing is added twice and the second pull stops at the first held page', async () => {
  const opened = await openDoor();
  const pages = title => ({
    pins: { '': { items: [pin('p2', title), pin('p1', 'Sourdough')], bookmark: 'B1' }, B1: { items: [pin('p0', 'Focaccia')], bookmark: null } },
    boards: { '': { items: [], bookmark: null } },
  });
  await pull('pinterest-pins', {}, pinterest(pages('Rye')), opened);
  const service = pinterest(pages('Dark rye'));
  const done = await pull('pinterest-pins', {}, service, opened);
  assert.equal(done.new_items, 0);
  assert.equal(calls(service, '/pins').length, 1);
  assert.equal((await snapshotOf(opened, 'pinterest-pins')).collections.pins.find(item => item.id === 'p2').title, 'Dark rye');
});

// ---- every source --------------------------------------------------------------------------------------------------

test('with no token nothing is asked of the service and nothing is read or written', async () => {
  const opened = await openDoor();
  for (const source of ['discord', 'slack', 'telegram', 'instagram-messages', 'messenger-messages', 'x-bookmarks', 'pinterest-pins']) {
    const service = fakeService(() => json({}));
    const done = await pullFromAnAccount(source, {}, { token: undefined, readToken: undefined, fetch: service.fetch, door: opened.door });
    assert.equal(done.status, 'needs_login', source);
    assert.match(done.said, /token/);
    assert.equal(service.calls.length, 0, source);
  }
  assert.equal(opened.calls.length, 0);
});

test('the token is in no answer, no error and nothing written to the records, even when the service repeats it back', async () => {
  const opened = await openDoor();
  const echo = fakeService(url => {
    if (url.pathname.endsWith('/users/@me')) return json({ id: '9' });
    if (url.pathname.endsWith('/guilds')) return json([{ id: 'g1', name: 'G' }]);
    if (url.pathname.endsWith('/channels')) return json([{ id: 'c1', name: 'one', type: 0 }]);
    return { status: 500, body: { message: `Internal error for ${TOKEN}` } };
  });
  const done = await pull('discord', {}, echo, opened);
  assert.equal(done.status, 'partial');
  assert.equal(JSON.stringify([done, opened.calls]).includes(TOKEN), false);
});

test('accounts are kept apart, and an account name with slashes and colons becomes one safe id segment', async () => {
  const opened = await openDoor();
  await pull('discord', { account: 'work' }, discord(), opened);
  await pull('discord', { account: 'home/team:1' }, discord({ orders: [post('1200000000000000009', 'Only at home')] }), opened);
  assert.equal((await snapshotOf(opened, 'discord', 'work')).threads[0].messages.length, 2);
  assert.equal((await snapshotOf(opened, 'discord', 'home/team:1')).threads[0].messages.length, 1);
  const ids = [...opened.kept.keys()];
  assert.ok(ids.every(id => id.split(':').length >= 4 && !id.includes('/')), ids.join(' '));
  assert.ok(ids.includes(stateId('discord', 'home/team:1')));
  assert.ok(ids.includes(threadId('discord', 'work', 'c-orders')));
  assert.equal(stateId('discord', 'home/team:1'), 'account-snapshot:discord:home~2fteam~3a1:state');
  assert.equal(itemId('x-bookmarks', 'a', 'bookmarks', 't:1'), 'account-snapshot:x-bookmarks:a:item:bookmarks:t~3a1');
});

test('input that is out of range is refused with what to give', async () => {
  const opened = await openDoor();
  const service = fakeService(() => json({}));
  await assert.rejects(pull('discord', { limit: 0 }, service, opened), /limit is a whole number from 1 to 500/);
  await assert.rejects(pull('discord', { most_pages: 21 }, service, opened), /most_pages is a whole number from 1 to 20/);
  await assert.rejects(pull('discord', { account: '' }, service, opened), /account is a name of 1 to 120 characters/);
  await assert.rejects(pull('nowhere', {}, service, opened), /There is no source called nowhere/);
  assert.equal(service.calls.length, 0);
});

test('at most most_threads conversations are read in one pull', async () => {
  const opened = await openDoor();
  const service = discord();
  const done = await pull('discord', { most_threads: 1 }, service, opened);
  assert.equal(done.threads, 1);
  assert.equal(calls(service, '/messages').length, 1);
});
