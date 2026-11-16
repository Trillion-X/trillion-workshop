// The connection query over the graph rows handed in: paths between two records (through relations and activities), what
// several records all relate to and who else shares it, and the DATA bounds that keep it fast. No records door is
// involved. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findConnections } from '../read-data/find-connections.mjs';
import { MODEL, textHash } from '../read-data/graph-records.mjs';
import { activityRow, me, relationRow } from './graph-rows.mjs';

const ann = 'record:crm:ann', bo = 'record:crm:bo', cy = 'record:crm:cy', pat = 'record:crm:pat';
const club = 'organisation:example-club';
const meeting = 'activity:meeting-1';

const seed = () => [
  relationRow(pat, 'dad', me),
  relationRow(me, 'member', club),
  relationRow(ann, 'member', club),
  relationRow(bo, 'member', club),
  relationRow(cy, 'member', club),
  relationRow(cy, 'sister', 'record:crm:old', { alive: false }),
  activityRow('meeting-1', 'meeting', '2026-05-03T15:00:00Z', [{ record: ann }, { record: bo, role: 'organiser' }, { record: me }]),
];

test('paths between two records, shortest first, through relations and the activities both took part in', async () => {
  const records = seed();
  const answer = await findConnections({ records, from: pat, to: bo });
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.paths.map(path => path.records), [
    [pat, me, meeting, bo],
    [pat, me, 'organisation:example-club', bo],
  ]);
  assert.deepEqual(answer.paths[0].steps.map(step => [step.kind, step.role, step.side]), [['relation', 'dad', 'subject'], ['activity', 'participant', 'participant'], ['activity', 'organiser', 'activity']]);
  assert.deepEqual(answer.paths[1].steps[0].by, `relation:${textHash(JSON.stringify([pat, 'dad', me]))}`);
  // Only some roles, or no activities, change what is walked.
  assert.deepEqual((await findConnections({ records, from: pat, to: bo, activities: false })).paths.map(path => path.length), [3]);
  assert.deepEqual((await findConnections({ records, from: pat, to: bo, roles: ['dad'], activities: false })).paths, []);
  assert.deepEqual((await findConnections({ records, from: 'me', to: ann, max_length: 2 })).paths.map(path => path.records.length), [3, 3]);
  assert.deepEqual((await findConnections({ records, from: pat, to: bo, max_length: 2 })).paths, [], 'nothing within two steps');
  // Ended relations are walked only when asked.
  assert.deepEqual((await findConnections({ records, from: cy, to: 'record:crm:old' })).paths, []);
  assert.deepEqual((await findConnections({ records, from: cy, to: 'record:crm:old', ended: true })).paths.map(path => path.length), [1]);
  // Longer paths come after the shortest, and no record is on a path twice.
  const longer = await findConnections({ records, from: ann, to: bo, max_length: 4 });
  assert.deepEqual(longer.paths.map(path => path.length), [2, 2, 4, 4]);
  for (const path of longer.paths) assert.equal(new Set(path.records).size, path.records.length);
});

test('what records share: the hubs they all relate to, and every other member of those hubs, most shared first', async () => {
  const records = seed();
  const answer = await findConnections({ records, of: [ann, bo] });
  assert.deepEqual(answer.hubs.map(hub => hub.id), [meeting, 'organisation:example-club']);
  assert.deepEqual(answer.hubs[0].held.map(held => [held.record, held.role]), [[ann, 'participant'], [bo, 'organiser']]);
  assert.deepEqual(answer.members.map(member => [member.id, member.hubs]), [[me, 2], [cy, 1]]);
  assert.deepEqual(answer.members[1].through.map(one => [one.hub, one.role, one.side]), [['organisation:example-club', 'member', 'subject']]);
  // One record: everything it relates to, and who else is related to each.
  const one = await findConnections({ records, from: cy });
  assert.deepEqual(one.hubs.map(hub => hub.id), ['organisation:example-club']);
  assert.deepEqual(one.members.map(member => member.id), [ann, bo, me], 'one hub each: by id');
  assert.deepEqual((await findConnections({ records, of: [pat, cy] })).hubs, [], 'nothing both relate to');
  assert.deepEqual((await findConnections({ records, of: ['me'], kinds: 'call' })).hubs.map(hub => hub.id), ['organisation:example-club', pat], 'only calls walked');
});

test('refusals say what to give', async () => {
  const records = seed();
  await assert.rejects(findConnections({ records: [] }), /Say which records to find connections for/);
  await assert.rejects(findConnections({ records, to: bo }), /need both: from and to/);
  await assert.rejects(findConnections({ records, from: bo, to: bo }), /the same record/);
  await assert.rejects(findConnections({ records, from: ann, to: bo, max_length: 7 }), /max_length is a whole number of steps from 1 to 6/);
  await assert.rejects(findConnections({ records, of: Array.from({ length: 21 }, (_, at) => `record:crm:${at}`) }), /at most 20 records/);
  await assert.rejects(findConnections({ records, of: [ann], kinds: 'pigeon' }), /An activity is one of/);
  await assert.rejects(findConnections({ records, of: [ann], ended: 'yes' }), /ended is true or false/);
});

test('every bound in the DATA cuts the walk and says so', async () => {
  const records = seed();
  const bounded = graph => ({ ...MODEL, graph: { ...MODEL.graph, ...graph } });
  const fewPaths = await findConnections({ records, from: pat, to: bo }, { model: bounded({ paths_most: 1 }) });
  assert.deepEqual([fewPaths.paths.length, fewPaths.complete], [1, false]);
  const fewRows = await findConnections({ records, from: pat, to: bo }, { model: bounded({ scan_most: 2 }) });
  assert.equal(fewRows.complete, false);
  assert.ok(fewRows.read.relations <= 2);
  const fewSteps = await findConnections({ records, from: ann, to: bo, max_length: 4 }, { model: bounded({ steps_most: 3 }) });
  assert.equal(fewSteps.complete, false);
  const fewMembers = await findConnections({ records, from: cy }, { model: bounded({ members_most: 1 }) });
  assert.deepEqual([fewMembers.members.length, fewMembers.count.members, fewMembers.complete], [1, 3, false]);
});

test('a graph of thousands of records answers within its bounds, quickly', async () => {
  // 3000 people in 300 groups of ten, each group's first member a member of the next group too: a long chain of hubs.
  const records = [];
  const relation = (subject, role, object) => ({ id: `relation:${textHash(JSON.stringify([subject, role, object]))}`, type: 'relation', value: { subject, role, object, alive: true, subject_order: 'V', object_order: 'V' } });
  for (let person = 0; person < 3000; person += 1) {
    const group = Math.floor(person / 10);
    records.push(relation(`record:crm:p${person}`, 'member', `group:g${group}`));
    if (person % 10 === 0 && group < 299) records.push(relation(`record:crm:p${person}`, 'member', `group:g${group + 1}`));
  }
  const started = performance.now();
  const near = await findConnections({ records, from: 'record:crm:p5', to: 'record:crm:p25', max_length: 6 });
  assert.deepEqual(near.paths.map(path => path.records), [['record:crm:p5', 'group:g0', 'record:crm:p0', 'group:g1', 'record:crm:p10', 'group:g2', 'record:crm:p25']]);
  assert.equal(near.complete, true);
  const far = await findConnections({ records, from: 'record:crm:p5', to: 'record:crm:p2995', max_length: 6 });
  assert.deepEqual(far.paths, [], 'too far for the longest path the DATA allows');
  assert.equal(far.read.relations, 3299);
  assert.ok(performance.now() - started < 10000, 'two whole-graph reads in well under ten seconds');
});
