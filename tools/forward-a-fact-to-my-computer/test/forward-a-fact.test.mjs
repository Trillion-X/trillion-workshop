// tools/forward-a-fact-to-my-computer/test/forward-a-fact.test.mjs
// One fact told through a stand-in gateway on loopback that answers as the door and the meeting point do: it checks the
// bearer, refuses a computer it carries none of, answers for a far computer that is down, and keeps each sender's fact once
// per event id (as trillion-rust src/wake.rs admits it), counting the causes it starts. Every key and fact here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { forward, requestKeyOf, factOf, answerOf, notForwarded, doorOk, tagged, consumersHere, SETTINGS } from '../do-work/forward-a-fact.mjs';

const KEY = 'made-up-forward-key-0123456789';
const fact = (event_id, payload = { chat: 'made-up-chat' }) => ({ kind: 'message-arrived', from: 'run', event_id, payload, coalesced: 0 });

/** A stand-in for this computer's own door (the run's door on descriptor 4): it answers wake:list for the capability it was
 *  given with the wakes `state.wakes` holds, or refuses when `state.refuse` is set. */
async function ownDoor() {
  const state = { wakes: [], refuse: false, asked: [] };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      const args = call.params.arguments;
      state.asked.push(args);
      const said = request.headers.authorization !== 'Bearer made-up-capability' || state.refuse
        ? { isError: true, structuredContent: { code: 'current_workspace_rights_refused' } }
        : { isError: false, structuredContent: { wakes: state.wakes.filter(wake => wake.on.fact.kind === args.input.kind), next: null } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: said }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, door: { url: `http://127.0.0.1:${server.address().port}/mcp`, resource: '@own-records', capability: 'made-up-capability' },
    close: () => new Promise(resolve => server.close(resolve)) };
}

const here = await ownDoor();
test.after(() => here.close());

/** A stand-in gateway. `state.far` is 'up' or 'down'; `state.heard` is how many far wakes hear the kind. */
async function gateway({ stream = false } = {}) {
  const state = { far: 'up', heard: 1, calls: [], started: new Set(), carried: new Set(['far-computer']) };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401).end(); return; }
      const call = JSON.parse(body);
      const args = call.params.arguments;
      state.calls.push(args);
      const result = said => {
        const json = JSON.stringify({ jsonrpc: '2.0', id: call.id, result: said });
        if (stream) response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${json}\n\n`);
        else response.writeHead(200, { 'content-type': 'application/json' }).end(json);
      };
      const [to] = args.pins;
      if (!state.carried.has(to)) {
        return result({ isError: true, structuredContent: { code: 'tools_pin_names_the_computer', detail: `no computer named ${to}; carried: far-computer, mac` } });
      }
      if (state.far === 'down') return result({ isError: true, structuredContent: { code: 'original_workspace_source_unavailable' } });
      const { kind, event_id } = args.input;
      if (state.heard === 0) {
        return result({ isError: false, structuredContent: { kind, event_id, from: 'sender', kept: false, heard_by: 0, starts: 'nothing: no wake that is on hears it',
          not_heard: { why: 'no_wake_hears', wakes_of_its_kind: 0 }, computer: to } });
      }
      // The far computer admits a sender's fact once per event id: a second one starts no second cause.
      state.started.add(event_id);
      return result({ isError: false, structuredContent: { kind, event_id, from: 'sender', kept: true, heard_by: state.heard, starts: 'now', computer: to } });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const door = `http://127.0.0.1:${server.address().port}/mcp`;
  return { state, door, server, close: () => new Promise(resolve => server.close(resolve)) };
}

test('one fact is told once, as it came, to the computer the wake names, under fact:<event id>', async () => {
  const stand = await gateway();
  const told = await forward({ fact: fact('m-1'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door });
  assert.deepEqual(told, { to: 'far-computer', computer: 'far-computer', kind: 'message-arrived', event_id: 'm-1', request_key: 'fact:m-1',
    kept: true, heard_by: 1, starts: 'now' });
  assert.deepEqual(stand.state.calls, [{ method: 'wake:arrive', request_key: 'fact:m-1', input: { kind: 'message-arrived', event_id: 'm-1', payload: { chat: 'made-up-chat', forwarded_from: 'mac' } },
    pins: ['far-computer'] }]);
  assert.equal(stand.state.started.size, 1);
  await stand.close();
});

test('the same event id told twice is the same call and starts one cause', async () => {
  const stand = await gateway();
  for (let round = 0; round < 2; round += 1) await forward({ fact: fact('m-2'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door });
  assert.deepEqual(stand.state.calls.map(call => call.request_key), ['fact:m-2', 'fact:m-2']);
  assert.equal(stand.state.started.size, 1);
  await stand.close();
});

test('a far computer that is down fails the run, and once it is up the retry tells it once', async () => {
  const stand = await gateway();
  stand.state.far = 'down';
  await assert.rejects(forward({ fact: fact('m-3'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door }),
    /far-computer did not keep message-arrived m-3 \(original_workspace_source_unavailable\); the wake asks again/);
  assert.equal(stand.state.started.size, 0);
  stand.state.far = 'up';
  assert.equal((await forward({ fact: fact('m-3'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door })).kept, true);
  assert.equal(stand.state.started.size, 1);
  await stand.close();
});

test('a gateway that does not answer fails the run, and once it answers the retry tells it once', async () => {
  const stand = await gateway();
  const door = stand.door;
  await stand.close();
  await assert.rejects(forward({ fact: fact('m-4'), to: 'far-computer', key: KEY, door, anyDoor: true, tag: 'mac', here: here.door }), /The gateway did not answer .*the wake asks again/);
  const again = await gateway();
  assert.equal((await forward({ fact: fact('m-4'), to: 'far-computer', key: KEY, door: again.door, anyDoor: true, tag: 'mac', here: here.door })).kept, true);
  assert.equal(again.state.started.size, 1);
  await again.close();
});

test('a kind no far wake hears is an answer, not a failure, so it is never asked again', async () => {
  const stand = await gateway();
  stand.state.heard = 0;
  const told = await forward({ fact: fact('m-5'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door });
  assert.equal(told.kept, false);
  assert.equal(told.heard_by, 0);
  assert.equal(told.not_heard.why, 'no_wake_hears');
  await stand.close();
});

test('a key the gateway refuses fails the run naming the key by its held name, never its value', async () => {
  const stand = await gateway();
  const refused = await forward({ fact: fact('m-6'), to: 'far-computer', key: 'made-up-expired-key', door: stand.door, anyDoor: true, tag: 'mac', here: here.door }).catch(error => error);
  assert.match(refused.message, new RegExp(`The gateway refused the key ${SETTINGS.key_name} \\(401\\)`));
  assert.ok(!refused.message.includes('made-up-expired-key'));
  await assert.rejects(forward({ fact: fact('m-6'), to: 'far-computer', key: '', door: stand.door, anyDoor: true, tag: 'mac', here: here.door }), /No key was handed on descriptor 3/);
  assert.equal(stand.state.calls.length, 0);
  await stand.close();
});

test('a computer the meeting point carries none of is refused, naming it and the computers it carries', async () => {
  const stand = await gateway();
  await assert.rejects(forward({ fact: fact('m-7'), to: 'no-such-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door }),
    /The meeting point carries no computer of yours named no-such-computer \(tools_pin_names_the_computer: no computer named no-such-computer; carried: far-computer, mac\)/);
  for (const to of ['', 'two words', 'a/b', 'x'.repeat(129), undefined]) {
    await assert.rejects(forward({ fact: fact('m-7'), to, key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door }), /The wake's input names no computer/);
  }
  assert.equal(stand.state.calls.length, 1, 'a name the door would not take is refused before any call');
  await stand.close();
});

test('an event-stream answer is read as the door gives it', async () => {
  const stand = await gateway({ stream: true });
  assert.equal((await forward({ fact: fact('m-8'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door })).kept, true);
  assert.equal(answerOf('application/json', 'not json'), null);
  await stand.close();
});

test('only a fact is told: a run no fact woke, or a payload that is not text fields, tells nothing', () => {
  assert.throws(() => factOf(undefined), /This run was not woken by a fact/);
  assert.throws(() => factOf({ kind: 'message-arrived' }), /This run was not woken by a fact/);
  assert.throws(() => factOf({ kind: 'k', event_id: 'e', payload: { n: 1 } }), /payload that is not text fields/);
  assert.deepEqual(factOf({ kind: 'k', event_id: 'e', from: 'run', coalesced: 0 }), { kind: 'k', event_id: 'e', payload: {} });
});

test('an event id too long for the door is named by its identity, the same each time', () => {
  const long = 'e'.repeat(400);
  assert.equal(requestKeyOf('short'), 'fact:short');
  assert.match(requestKeyOf(long), /^key:1f:[0-9a-f]{64}$/);
  assert.equal(requestKeyOf(long), requestKeyOf(long));
  assert.notEqual(requestKeyOf(long), requestKeyOf(`${long}x`));
});

test("this tool's own failure is answered with no call, so a gateway that is down cannot feed its failures back without end", async () => {
  const stand = await gateway();
  const own = { kind: 'wake-failed', from: 'wake', event_id: 'f-1', payload: { tool: 'tool:forward-a-fact-to-my-computer', wake: 'forward-message-arrived', cause: 'c' } };
  const answered = await forward({ fact: own, to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door });
  assert.equal(answered.forwarded, false);
  assert.match(answered.why, /this tool's own/);
  assert.equal(stand.state.calls.length, 0);
  const other = { ...own, event_id: 'f-2', payload: { ...own.payload, tool: 'tool:read-my-messages' } };
  assert.equal(notForwarded(factOf(other)), null, "another tool's failure is told");
  assert.equal((await forward({ fact: other, to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door })).kept, true);
  await stand.close();
});

test('a door that is not an https address with a host is refused before any call', async () => {
  for (const door of [undefined, '', 'http://gateway.example/mcp', ['https://made-up-user:made-up-word', 'gateway.example/mcp'].join(String.fromCharCode(64)), 'not an address']) {
    assert.equal(doorOk(door), false, String(door));
    await assert.rejects(forward({ fact: fact('m-9'), to: 'far-computer', door, key: KEY, tag: 'mac', here: here.door, fetchImpl: () => assert.fail('no call') }), /names no gateway door/);
  }
  assert.equal(doorOk('https://gateway.example/mcp'), true);
});

test('a wake of another tool on here that hears the same kind from the same teller refuses the forward, naming it', async () => {
  const stand = await gateway();
  const wake = (tool, id, from, switched_on = true) => ({ tool, id, switched_on, on: { fact: { kind: 'message-arrived', from } } });
  here.state.wakes = [wake('tool:run-a-workflow', 'a-thing-showed-up/rows', ['run'])];
  await assert.rejects(forward({ fact: fact('m-10'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door }),
    /tool:run-a-workflow a-thing-showed-up\/rows is still on here and hears this kind from the same teller: switch it off here/);
  assert.equal(stand.state.calls.length, 0, 'nothing is told while the work would run on both computers');
  // Switched off here, another teller's wake, and this tool's own wake are not consumers of the fact.
  here.state.wakes = [wake('tool:run-a-workflow', 'a-thing-showed-up/rows', ['run'], false), wake('tool:other', 'hears-senders', ['sender']),
    wake('tool:forward-a-fact-to-my-computer', 'forward-message-arrived', ['run'])];
  assert.equal((await forward({ fact: fact('m-10'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door })).kept, true);
  here.state.wakes = [];
  await stand.close();
});

test('a door that does not list the wakes here tells nothing, so a fact is never told blind', async () => {
  const stand = await gateway();
  here.state.refuse = true;
  await assert.rejects(forward({ fact: fact('m-11'), to: 'far-computer', key: KEY, door: stand.door, anyDoor: true, tag: 'mac', here: here.door }),
    /did not list its message-arrived wakes \(current_workspace_rights_refused\); nothing is told/);
  here.state.refuse = false;
  await assert.rejects(consumersHere({ door: null, kind: 'message-arrived', teller: 'run' }), /handed no door on descriptor 4/);
  assert.equal(stand.state.calls.length, 0);
  await stand.close();
});

test('the forwarded fact carries its tag, and a fact that holds the tag field already or has no room for it is refused', async () => {
  const told = factOf(fact('m-12'));
  assert.deepEqual(tagged(told, 'mac').payload, { chat: 'made-up-chat', forwarded_from: 'mac' });
  assert.throws(() => tagged(factOf(fact('m-12', { forwarded_from: 'elsewhere' })), 'mac'), /already holds forwarded_from/);
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`f${n}`, 'x']));
  assert.throws(() => tagged(factOf(fact('m-12', eight)), 'mac'), /would pass the 8 a fact may hold/);
  for (const tag of [undefined, '', 'Mac', 'two words', 'x'.repeat(65)]) {
    await assert.rejects(forward({ fact: fact('m-12'), to: 'far-computer', door: 'https://gateway.example/mcp', key: KEY, tag, here: here.door, fetchImpl: () => assert.fail('no call') }),
      /names no forwarded_from/);
  }
});
