// Voices named from the call app's own screen (read-data/name-from-the-call.mjs, DATA in read-data/name-from-the-call.json).
import assert from 'node:assert/strict';
import test from 'node:test';
import { callSettings, callTools, intervalsOf, namesSpeaking, reconcile, rowFor } from '../read-data/name-from-the-call.mjs';

const settings = callSettings();
const row = rowFor(settings, 'Some Call App');

test('the speaker is read from the elements the DATA row names, with the app suffixes cut off', () => {
  const elements = [
    { role: 'button', label: 'Mute' },
    { role: 'group', label: 'Priya Shah (Host), is speaking' },
    { role: 'group', label: 'Active speaker: Ben' },
    { role: 'group', label: 'Priya Shah (Host), is speaking' },
  ];
  assert.deepEqual(namesSpeaking(elements, row), ['Priya Shah', 'Ben']);
  assert.deepEqual(namesSpeaking(elements, null), []);
  assert.equal(rowFor({ apps: [{ id: 'a', app_contains: ['zoom'] }, { id: 'b' }] }, 'Zoom Meetings').id, 'a');
  assert.equal(rowFor({ apps: [{ id: 'a', app_contains: ['zoom'] }, { id: 'b' }] }, 'Other').id, 'b');
});

test('samples become intervals shifted back by the lag and capped by the gap', () => {
  const out = intervalsOf([{ at_ms: 10_000, names: ['Ana'] }, { at_ms: 12_000, names: ['Ben'] }, { at_ms: 30_000, names: ['Ana'] }], { mostGapMs: 5000, lagMs: 500 });
  assert.deepEqual(out, [
    { start_ms: 9500, end_ms: 11_500, name: 'Ana' },
    { start_ms: 11_500, end_ms: 16_500, name: 'Ben' },
    { start_ms: 29_500, end_ms: 34_500, name: 'Ana' },
  ]);
});

test('a voice is named only on enough of the screen evidence, and a name goes to one voice only', () => {
  const turns = [
    { start_ms: 0, end_ms: 10_000, voice: 'V1' }, { start_ms: 10_000, end_ms: 20_000, voice: 'V2' },
    { start_ms: 20_000, end_ms: 25_000, voice: 'V3' }, { start_ms: 25_000, end_ms: 26_000, voice: 'V4' },
  ];
  const intervals = [
    { start_ms: 0, end_ms: 9000, name: 'Ana' },
    { start_ms: 10_000, end_ms: 14_000, name: 'Ben' }, { start_ms: 14_000, end_ms: 20_000, name: 'Ana' },
    { start_ms: 20_000, end_ms: 22_000, name: 'Cho' },
    { start_ms: 25_000, end_ms: 26_000, name: 'Dee' },
  ];
  const found = reconcile(turns, intervals, settings.reconcile);
  assert.deepEqual(found.assignments.map(a => [a.voice, a.name]), [['V1', 'Ana']]);
  assert.deepEqual(found.unnamed.find(u => u.voice === 'V2').candidates.map(c => c.name), ['Ana', 'Ben']);
  assert.ok(found.unnamed.some(u => u.voice === 'V3'), 'Cho was shown for 2s of 5s, under the share and the least seconds');
  assert.ok(found.unnamed.some(u => u.voice === 'V4'), 'one second is under least_overlap_seconds');
});

test('the tool lays the screen over unnamed voices only and writes each name through name_speaker with its evidence', async () => {
  const calls = [];
  const turns = [
    { start: 0, end: 10, who: 'Someone (voice-1)' }, { start: 10, end: 20, who: 'Someone (voice-2)' },
    { start: 20, end: 30, who: 'Maria' },
  ];
  const samples = Array.from({ length: 20 }, (_, index) => ({ at: index * 1000 + 600, elements: [{ label: `${index < 10 ? 'Priya' : 'Ben'}, is speaking` }] }))
    .concat(Array.from({ length: 10 }, (_, index) => ({ at: 20_600 + index * 1000, names: ['Maria'] })));
  const answer = await callTools.name({ turns, samples, app: 'Some Call App', apply: { app: 'Listening', since: '2026-10-19T09:00:00.000Z', until: '2026-10-19T09:01:00.000Z' } },
    { call: async (tool, args) => { calls.push({ tool, args }); return { renamed: 3 }; } });
  assert.deepEqual(answer.assignments.map(a => [a.voice, a.name]), [['Someone (voice-1)', 'Priya'], ['Someone (voice-2)', 'Ben']]);
  assert.equal(calls.length, 2, 'Maria is already named and is not laid over');
  assert.equal(calls[0].tool, 'name_speaker');
  assert.equal(calls[0].args.speaker, 'Someone (voice-1)');
  assert.match(calls[0].args.evidence, /99% of the time this voice spoke, 10 seconds/);
  console.log('REAL readback of the name_speaker call:', JSON.stringify(calls[0]));
  await assert.rejects(callTools.name({ turns, samples, apply: { app: 'Listening' } }, { call: async () => ({}) }), /since and until/);
  await assert.rejects(callTools.name({ turns: [], samples }), /Give turns/);
  const dry = await callTools.name({ turns, samples, app: 'Some Call App' });
  assert.equal(dry.named, undefined, 'without apply nothing is written');
});
