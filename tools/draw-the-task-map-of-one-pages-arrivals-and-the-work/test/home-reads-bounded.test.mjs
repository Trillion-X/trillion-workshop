// Ported from old trillion test/home-reads-bounded.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The two task-map tests are kept. The old test asked the retired PersonStore's
// messageTaskCanvas, which drew a page of messages with this tool's drawnArrivals and drawnWork (src/task-map-reads.mjs);
// here `taskMap` below makes that answer the same way (old src/person-store.mjs messageTaskCanvas, its arrivals and
// handoffs; its asked, blocks, activity and related pursuits and decisions are empty, as the drawn records here carry
// none) over keep-and-wake's decision store and messages, and tools/shared-code makeAgents over hand-work-to-ais'
// agentRecordStore on the same records. messageTaskGraph is tools/see-what-is-being-worked-on/message-task-canvas.mjs.
// Their assertions are the old ones.
// Left out: "Home and the notification reads cost the same at four times the account, cold", which booted the retired
// PersonStore cold and measured its aiWork, waitingOnYou, workScreen, connectionsNow, notifications and messageTaskCanvas
// reads as one store (its own boot charged to each): searched the three repos for messageTaskCanvas, aiWork, workScreen,
// connectionsNow and waitingOnYou: no running owner composes these reads over one store (trillion-apps and the Workshop
// hold their screens, each over its own route).
//
// The task map answers what it draws of each arrival and job (src/task-map-reads.mjs), from the index entries that carry
// it; an entry kept before it carried them is read by those fields alone. Both roads answer the same, and the map built
// from the answer links every message to the same work, files and decisions as one built from the whole records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawnArrivals, drawnWork } from '../src/task-map-reads.mjs';
import { messageTaskGraph } from '../../see-what-is-being-worked-on/message-task-canvas.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { messages } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';

// The answer the old messageTaskCanvas gave for its first page: the page's messages, what the map draws of their
// arrivals and work, and the newest jobs.
const taskMap = person => {
  const page = messages(person.store.eeaf).read({ limit: 100 });
  const ids = page.messages.map(message => message.id);
  return { messages: page.messages, arrivals: drawnArrivals(person.store.eeaf, ids), asked: [], blocks: [], activity: [],
    handoffs: drawnWork(person.agentStore, ids, { first: true }), related: [], next_before: page.next_before };
};

async function taskMapAccount() {
  const host = sqliteHost(':memory:');
  const store = decisionStore(host.sql, { transaction: host.transaction });
  const eeaf = store.eeaf;
  let saved = null;
  const agentStore = { ...agentRecordStore({ records: eeaf, transaction: host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } };
  const agents = makeAgents({ store: agentStore });
  const person = { store, agentStore };
  messages(eeaf).record({ messages: [
    { conversation_id: 'drawn-map', speaker: 'person', text: 'Look into the first request', at: '2026-10-12T01:00:00Z' },
    { conversation_id: 'drawn-map', speaker: 'person', text: 'Look into the second request', at: '2026-10-12T01:01:00Z' },
  ] }, { app: 'Proof AI', reader: null, road: 'record_messages' });
  const ids = messages(eeaf).read({ limit: 100 }).messages.map(row => row.id).sort();
  eeaf.write([
    { id: 'arrival:drawn-a', type: 'arrival', value: { message_id: ids[0], route: 'chat', title: 'First request', at: '2026-10-12T01:00:01Z', job: 'All the source words '.repeat(50), files: [{ id: 'file:one', name: 'One.pdf' }] } },
    { id: 'arrival:drawn-b', type: 'arrival', value: { message_id: ids[1], route: 'email', at: '2026-10-12T01:01:01Z', job: 'Second source words', resolved_text: 'Resolved words' } },
  ], { actor: { by: 'person' } });
  const root = agents.handOff({ job: 'Root job words '.repeat(40), said: 'Root job', request_key: 'drawn-root', input: { arrived: { message_id: ids[0] }, detail: 'Private context words' } }).handoff;
  agents.handOff({ job: 'Part job words', said: 'Part job', request_key: 'drawn-part', parent_handoff_id: root.handoff_id });
  const kept = agentStore.handoff(root.handoff_id);
  agentStore.putHandoff({ ...kept, state: 'finished', finished_at: '2026-10-12T02:00:00Z', summary: 'Done.', result: 'Result words '.repeat(100), case_id: 'case_drawn' });
  return { person, eeaf, ids, root, close: () => host.db.close() };
}
const wholeAnswer = (person, answer) => ({ ...answer,
  arrivals: answer.arrivals.map(row => ({ id: row.id, ...person.store.eeaf.read(row.id) })),
  handoffs: answer.handoffs.map(row => person.agentStore.handoff(row.handoff_id)) });
const linksOf = answer => {
  const { nodes, edges } = messageTaskGraph(answer);
  return { edges: edges.map(edge => edge.id).sort(), nodes: nodes.map(node => [node.id, node.kind, node.opens ?? null]).sort((a, b) => a[0].localeCompare(b[0])) };
};

test('the task map answers what it draws of each arrival and job, never their words, results or other input', async () => {
  const { person, ids, root, close } = await taskMapAccount();
  try {
    const answer = taskMap(person);
    assert.deepEqual(answer.arrivals.filter(row => row.id.startsWith('arrival:drawn')).sort((a, b) => a.id.localeCompare(b.id)), [
      { id: 'arrival:drawn-a', message_id: ids[0], files: [{ id: 'file:one', name: 'One.pdf' }] },
      { id: 'arrival:drawn-b', message_id: ids[1] },
    ]);
    const drawnRoot = answer.handoffs.find(row => row.handoff_id === root.handoff_id);
    assert.deepEqual(drawnRoot, { handoff_id: root.handoff_id, case_id: 'case_drawn', state: 'finished', handed_at: root.handed_at, input: { arrived: { message_id: ids[0] } } });
    const part = answer.handoffs.find(row => row.parent_handoff_id === root.handoff_id);
    assert.deepEqual(Object.keys(part ?? {}).sort(), ['handed_at', 'handoff_id', 'parent_handoff_id', 'state']);
    for (const row of answer.handoffs) for (const field of ['job', 'said', 'result', 'summary', 'corrections']) assert.equal(row[field], undefined, `${row.handoff_id} carries no ${field}`);
    assert.equal(JSON.stringify(answer).includes('Private context words'), false);
    for (const words of ['source words', 'Root job', 'Part job', 'First request']) assert.equal(JSON.stringify(answer).includes(words), false, words);
    // The map built from the answer has every link, file and decision the whole records give it.
    assert.deepEqual(linksOf(answer), linksOf(wholeAnswer(person, answer)));
    assert.ok(linksOf(answer).edges.includes(`${root.handoff_id}->case_drawn`) && linksOf(answer).edges.includes(`${ids[0]}->file:one`));
  } finally { close(); }
});

test('an arrival or job whose index entry does not carry what the map draws is read by those fields, and a refused read refuses the page', async () => {
  const { person, eeaf, close } = await taskMapAccount();
  const indexCovered = eeaf.indexCovered;
  const projectOf = eeaf.fields.projectOf;
  try {
    const carried = taskMap(person);
    // As before an index build reaches them: no entry is known to carry the drawn fields.
    eeaf.indexCovered = () => new Set();
    const read = [];
    eeaf.fields.projectOf = (type, selected, options) => { read.push([type, options.fields]); return projectOf(type, selected, options); };
    const byFields = taskMap(person);
    assert.deepEqual(byFields.arrivals, carried.arrivals);
    assert.deepEqual(byFields.handoffs, carried.handoffs);
    assert.ok(read.some(([type]) => type === 'arrival') && read.some(([type]) => type === 'agent-handoff'), JSON.stringify(read));
    for (const [, fields] of read) for (const field of ['job', 'said', 'title', 'result', 'summary', 'resolved_text']) assert.equal(fields.includes(field), false, `${field} is never selected`);
    const refused = new Error('selected fields refused');
    eeaf.fields.projectOf = (type, selected, options) => { if (type === 'arrival') throw refused; return projectOf(type, selected, options); };
    await assert.rejects(async () => taskMap(person), error => error === refused);
  } finally {
    eeaf.indexCovered = indexCovered;
    eeaf.fields.projectOf = projectOf;
    close();
  }
});
