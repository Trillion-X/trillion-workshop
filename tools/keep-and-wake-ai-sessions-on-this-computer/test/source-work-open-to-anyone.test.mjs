import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents, anyoneFrom } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import workSources from '../../shared-code/src/work-sources.json' with { type: 'json' };

function clock(start = '2026-09-30T12:00:00Z') {
  let time = new Date(start).getTime();
  return { now: () => new Date(time), advance: minutes => { time += minutes * 60_000; } };
}
const general = agents => agents.publish({ agent_id: 'helper', name: 'Helper', description: 'Takes any work', takes_work: true });

test('work from a place with no chat is taken by any of the person\'s AIs once its chat\'s first turn is over', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  const note = agents.handOff({ job: 'A note the person wrote', request_key: 'note', input: { arrived: { route: 'A notes app', source_id: 'note-17' } } }).handoff;
  assert.equal(note.anyone_from, new Date(Date.parse(note.handed_at) + workSources.chat_silence_minutes * 60_000).toISOString());
  assert.equal(agents.take({ agent_id: 'helper' }).handoff, null, 'the chat gets first refusal');
  assert.match(agents.reconcile().blocked.join(), new RegExp(note.handoff_id));
  time.advance(workSources.chat_silence_minutes);
  agents.reconcile();
  const taken = agents.take({ agent_id: 'helper' }).handoff;
  assert.equal(taken.handoff_id, note.handoff_id);
  assert.equal(taken.in_the_way, null);
});

test('a carrier that says its place has no chat lets any AI take the work at once', () => {
  const agents = makeAgents({ store: agentStoreForTests(), now: clock().now });
  general(agents);
  const memo = agents.handOff({ job: 'A voice memo', request_key: 'memo', input: { arrived: { source_id: 'memo-3', chat_first_minutes: 0 } } }).handoff;
  assert.equal(memo.anyone_from, memo.handed_at);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: memo.handoff_id }).handoff.handoff_id, memo.handoff_id);
});

test('the chat it came from takes it first; once its turn is over, any AI takes it, so nothing waits for a closed chat', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  agents.publish({ agent_id: 'chat-a', name: 'Chat A', description: 'The chat', takes_work: true, source_id: 'claude-code:a' });
  const asked = agents.handOff({ job: 'Written in chat A', request_key: 'chat', input: { arrived: { source_id: 'claude-code:a' } } }).handoff;
  assert.equal(agents.take({ agent_id: 'helper' }).handoff, null, 'the chat gets first refusal');
  time.advance(workSources.chat_silence_minutes);
  agents.reconcile();
  assert.equal(agents.take({ agent_id: 'helper' }).handoff.handoff_id, asked.handoff_id, 'the chat closed without taking it');
});


test('a two-hour live chat keeps its queued work through source heartbeats', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  agents.publish({ agent_id: 'chat-live', name: 'Live chat', description: 'The source chat', takes_work: true, source_id: 'codex:live' });
  const asked = agents.handOff({ job: 'Queued during a long turn', request_key: 'live-two-hours', input: { arrived: { source_id: 'codex:live' } } }).handoff;
  for (let elapsed = 50; elapsed <= 150; elapsed += 50) {
    time.advance(50);
    agents.presence({ agent_id: 'chat-live' });
    assert.equal(agents.take({ agent_id: 'helper', handoff_id: asked.handoff_id }).handoff, null, `unrelated AI refused after ${elapsed} live minutes`);
  }
  assert.equal(agents.take({ agent_id: 'chat-live', handoff_id: asked.handoff_id }).handoff.handoff_id, asked.handoff_id);
});

test('a new transcript row restarts the silence window, then closed-chat work recovers to any AI', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  const asked = agents.handOff({ job: 'Queued while transcript grows', request_key: 'transcript-live', input: { arrived: { source_id: 'codex:transcript' } } }).handoff;
  time.advance(50);
  const activity = agents.sourceActive({ source_id: 'codex:transcript', active_at: time.now().toISOString() });
  assert.deepEqual(activity.handoff_ids, [asked.handoff_id]);
  time.advance(20);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: asked.handoff_id }).handoff, null, 'the original fixed deadline no longer releases live source work');
  time.advance(40);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: asked.handoff_id }).handoff.handoff_id, asked.handoff_id, 'the same work releases after a full silent window');
});

test('a chat that connects after its work arrived is preferred while its source stays active', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  const asked = agents.handOff({ job: 'Written in chat C', request_key: 'c', input: { arrived: { source_id: 'claude-code:c' } } }).handoff;
  agents.publish({ agent_id: 'chat-c', name: 'Chat C', description: 'The chat', takes_work: true, source_id: 'claude-code:c' });
  const named = agents.read({ handoff_id: asked.handoff_id }).handoff;
  assert.equal(named.to_agent, 'chat-c');
  assert.deepEqual(named.target, { strict: false, prefer_until: asked.anyone_from });
  time.advance(workSources.chat_silence_minutes);
  agents.reconcile();
  assert.equal(agents.take({ agent_id: 'helper' }).handoff.handoff_id, asked.handoff_id);
});

test('two chats saying they are the one it came from never block it, and after the source goes silent any AI takes it', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  for (const id of ['chat-x', 'chat-y']) agents.publish({ agent_id: id, name: id, description: 'The chat', takes_work: true, source_id: 'claude-code:same' });
  const asked = agents.handOff({ job: 'Written in one of them', request_key: 'same', input: { arrived: { source_id: 'claude-code:same' } } }).handoff;
  assert.equal(agents.reconcile().blocked.length, 0, 'two owners of one chat never block its work');
  time.advance(workSources.chat_silence_minutes);
  agents.reconcile();
  const taken = agents.take({ agent_id: 'helper' }).handoff;
  assert.equal(taken.handoff_id, asked.handoff_id);
  assert.equal(taken.in_the_way, null);
});

test('while the source is active the chat that connects takes it before anyone else', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  const asked = agents.handOff({ job: 'Written in chat B', request_key: 'b', input: { arrived: { source_id: 'codex:b' } } }).handoff;
  time.advance(workSources.chat_silence_minutes / 2);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: asked.handoff_id }).handoff, null);
  agents.publish({ agent_id: 'chat-b', name: 'Chat B', description: 'The chat', takes_work: true, source_id: 'codex:b' });
  assert.equal(agents.take({ agent_id: 'chat-b', handoff_id: asked.handoff_id }).handoff.handoff_id, asked.handoff_id);
});

test('work with no chat and work named to an agent say nothing about a chat\'s turn', () => {
  const agents = makeAgents({ store: agentStoreForTests(), now: clock().now });
  general(agents);
  assert.equal(anyoneFrom(agents.handOff({ job: 'Plain', request_key: 'plain' }).handoff), null);
  assert.equal(agents.handOff({ job: 'Named', request_key: 'named', to_agent: 'helper', input: { arrived: { source_id: 'note-1' } } }).handoff.anyone_from, undefined);
});

test('work named to an AI that never comes opens to another AI once the unseen window ends, and a take then succeeds', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  agents.publish({ agent_id: 'gone-agent', name: 'Gone', description: 'Published once, never seen again', takes_work: true });
  const job = agents.handOff({ job: 'Follow up a share', request_key: 'gone', to_agent: 'gone-agent', target: { prefer_minutes: 7 * 24 * 60 } }).handoff;
  assert.equal(anyoneFrom(job), null, 'a caller that knows no card keeps the old answer');
  assert.equal(anyoneFrom(job, null), new Date(Date.parse(job.handed_at) + workSources.named_agent_unseen_minutes * 60_000).toISOString(), 'no card is never seen');
  assert.equal(anyoneFrom({ to_agent: 'gone-agent', target: null, handed_at: job.handed_at }, null), anyoneFrom(job, null), 'a job with no target at all opens the same way');
  time.advance(workSources.named_agent_unseen_minutes - 1);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: job.handoff_id }).handoff, null, 'still inside the window');
  time.advance(1);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: job.handoff_id }).handoff.handoff_id, job.handoff_id);
});

test('work named to an AI that is still seen stays with it, and the window counts from its last sighting', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  agents.publish({ agent_id: 'present', name: 'Present', description: 'Takes work', takes_work: true });
  const job = agents.handOff({ job: 'For the present AI', request_key: 'present', to_agent: 'present', target: { prefer_minutes: 7 * 24 * 60 } }).handoff;
  time.advance(workSources.named_agent_unseen_minutes - 10);
  agents.presence({ agent_id: 'present' });
  time.advance(workSources.named_agent_unseen_minutes - 10);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: job.handoff_id }).handoff, null, 'seen less than a window ago');
  time.advance(10);
  agents.reconcile();
  const released = agents.read({ handoff_id: job.handoff_id }).handoff;
  assert.equal(released.to_agent, null);
  assert.equal(released.preferred_agent, 'present');
  assert.equal(agents.take({ agent_id: 'helper' }).handoff.handoff_id, job.handoff_id);
});

test('work pinned strict: true to an AI that is gone stays closed to every other AI', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  agents.publish({ agent_id: 'gone-agent', name: 'Gone', description: 'Published once, never seen again', takes_work: true });
  const job = agents.handOff({ job: 'Needs that computer', request_key: 'strict', to_agent: 'gone-agent', target: { strict: true } }).handoff;
  const pinned = agents.read({ handoff_id: job.handoff_id }).handoff;
  assert.equal(pinned.target?.strict, true);
  time.advance(workSources.named_agent_unseen_minutes * 2);
  agents.reconcile();
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: job.handoff_id }).handoff, null);
  assert.equal(agents.read({ handoff_id: job.handoff_id }).handoff.to_agent, 'gone-agent');
});

test('the AI holding a job releases it at once and the next AI can take it', () => {
  const agents = makeAgents({ store: agentStoreForTests(), now: clock().now });
  general(agents);
  agents.publish({ agent_id: 'other', name: 'Other', description: 'Takes any work', takes_work: true });
  const job = agents.handOff({ job: 'Anything', request_key: 'r' }).handoff;
  const taken = agents.take({ agent_id: 'helper' });
  assert.throws(() => agents.release({ handoff_id: job.handoff_id, agent_id: 'other' }), /not held by other/);
  const released = agents.release({ handoff_id: job.handoff_id, agent_id: 'helper', generation: taken.generation, because: 'Trillion kept answering busy' }).handoff;
  assert.equal(released.state, 'open');
  assert.equal(released.attempts.at(-1).ended, 'released');
  assert.equal(agents.take({ agent_id: 'other' }).handoff.handoff_id, job.handoff_id);
});


test('transcript activity holds source-managed work beyond its owner card unseen window', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  agents.publish({ agent_id: 'transcript-owner', name: 'Transcript owner', description: 'Its own active chat', source_id: 'transcript:long' });
  const handed = agents.handOff({ job: 'Queued in a long-running transcript', request_key: 'transcript-after-card',
    input: { arrived: { source_id: 'transcript:long', chat_silence_minutes: 60 } } }).handoff;
  time.advance(workSources.named_agent_unseen_minutes - 10);
  agents.sourceActive({ source_id: 'transcript:long', active_at: time.now().toISOString() });
  time.advance(10);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: handed.handoff_id }).handoff, null, 'the live source window wins over the separate stale-card timeout');
  time.advance(50);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: handed.handoff_id }).handoff.handoff_id, handed.handoff_id, 'work opens once the actual source window ends');
});

test('source timestamps remain authored and monotonic while each job keeps its own silence duration', () => {
  const time = clock();
  const agents = makeAgents({ store: agentStoreForTests(), now: time.now });
  general(agents);
  const first = agents.handOff({ job: 'Short silence', request_key: 'source-short', input: { arrived: { source_id: 'source:duration', chat_silence_minutes: 20 } } }).handoff;
  const second = agents.handOff({ job: 'Long silence', request_key: 'source-long', input: { arrived: { source_id: 'source:duration', chat_silence_minutes: 60 } } }).handoff;
  time.advance(10);
  const active_at = time.now().toISOString();
  assert.equal(agents.sourceActive({ source_id: 'source:duration', active_at }).handoff_ids.length, 2);
  assert.deepEqual(agents.sourceActive({ source_id: 'source:duration', active_at: first.handed_at }).handoff_ids, [], 'old import time cannot renew or rewind source activity');
  assert.deepEqual(agents.sourceActive({ source_id: 'source:duration', active_at }).handoff_ids, [], 'equal activity needs no write');
  time.advance(20);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: first.handoff_id }).handoff.handoff_id, first.handoff_id);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: second.handoff_id }).handoff, null);
  time.advance(40);
  assert.equal(agents.take({ agent_id: 'helper', handoff_id: second.handoff_id }).handoff.handoff_id, second.handoff_id);
});
