import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupSessions, parseSidecar, readCameraCardIndex, readCameraCardIndexTool, seedOfSession } from '../read-data/camera-card-index.mjs';

const sidecar = (created, frames, rate = 24) => `<?xml version="1.0"?>
<NonRealTimeMeta>
	<Duration value="${frames}"/>
	<LtcChangeTable tcFps="${rate}" halfStep="false">
		<LtcChange frameCount="0" value="12170000" status="increment"/>
	</LtcChangeTable>
	<CreationDate value="${created}"/>
</NonRealTimeMeta>`;

// A pretend card: a camera index folder with clips, sidecars, and the odd thing a real card can hold.
function pretendCard(files, identity = '6C44E496-0C38-48BA-B9F3-52A1213FF8F9') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'camera-card-')));
  const clip = join(root, 'M4ROOT', 'CLIP');
  mkdirSync(clip, { recursive: true });
  mkdirSync(join(root, '.fseventsd'));
  writeFileSync(join(root, '.fseventsd', 'fseventsd-uuid'), `${identity}\n`);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(clip, name), body);
  return { root, clip };
}

test('a sidecar gives its start and its length in seconds from frames at its own rate', () => {
  const parsed = parseSidecar(sidecar('2026-11-20T10:36:55-06:00', 57168, 24));
  assert.equal(parsed.start.toISOString(), '2026-11-20T16:36:55.000Z');
  assert.equal(parsed.seconds, 2382);
  assert.equal(parseSidecar('<NonRealTimeMeta/>'), null);
  assert.equal(parseSidecar(sidecar('not a date', 10)), null);
});

test('clips join one session while each starts within the gap of the last end, and a longer gap starts a new one', () => {
  const at = (iso, seconds) => ({ name: iso, path: iso, start: new Date(iso), seconds });
  const sessions = groupSessions([
    at('2026-11-20T10:00:00Z', 600),
    at('2026-11-20T10:20:00Z', 60),
    at('2026-11-20T12:30:00Z', 60),
  ], 1800);
  assert.deepEqual(sessions.map(s => s.clips.length), [2, 1]);
  assert.equal(sessions[0].end.toISOString(), '2026-11-20T10:21:00.000Z');
});

test('a card gives one seed per session, read only, and leaves out what is before the cutoff or cannot be read', () => {
  const { root, clip } = pretendCard({
    'C0001M01.XML': sidecar('2026-11-18T20:00:00-06:00', 240), // before the cutoff in DATA
    'C0001.MP4': 'x',
    'C0005M01.XML': sidecar('2026-11-20T10:36:55-06:00', 24 * 600),
    'C0005.MP4': 'x',
    'C0006M01.XML': sidecar('2026-11-20T10:50:00-06:00', 24 * 120),
    'C0006.MP4': 'x',
    'C0007M01.XML': sidecar('2026-11-20T13:00:00-06:00', 24 * 60),
    'C0007.MP4': 'x',
    'C0008M01.XML': 'not xml at all',
    'C0008.MP4': 'x',
    'C0009M01.XML': sidecar('2026-11-20T14:00:00-06:00', 24),
  });
  const before = readdirSync(clip).sort().join(',');
  const device = { name: 'Test card', mount: root, internal: false };
  return readCameraCardIndex({ target: root, devices: [device] }).then(answer => {
    assert.equal(readdirSync(clip).sort().join(','), before, 'the card is not written to');
    assert.equal(answer.clips_before_since, 1);
    assert.equal(answer.sidecars_unreadable, 1);
    assert.equal(answer.sidecars_without_media, 1);
    assert.equal(answer.clips_in_range, 3);
    assert.equal(answer.sessions.length, 2);
    const [morning, afternoon] = answer.sessions;
    assert.equal(morning.id, 'camera-card:6C44E496-0C38-48BA-B9F3-52A1213FF8F9:C0005');
    assert.equal(morning.words, 'pending');
    assert.equal(morning.came_from.source, 'volume');
    assert.equal(morning.came_from.volume, join(root).split('/').pop());
    assert.deepEqual(morning.came_from.paths, [join(clip, 'C0005.MP4'), join(clip, 'C0006.MP4')]);
    assert.equal(morning.media.session.clip_count, 2);
    assert.equal(morning.media.session.total_seconds, 720);
    assert.equal(morning.media.clips[0].stored_as, null);
    assert.equal(morning.media.clips[0].bytes, 1, 'the media is sized by stat, never read');
    assert.equal(morning.at, '2026-11-20T16:36:55.000Z');
    assert.equal(afternoon.id, 'camera-card:6C44E496-0C38-48BA-B9F3-52A1213FF8F9:C0007');
  });
});

test('a volume with no camera index holds no sessions, and a path off the connected drives is refused', async () => {
  const { root } = pretendCard({});
  const device = { name: 'Plain disk', mount: root, internal: false };
  const answer = await readCameraCardIndex({ target: root, devices: [device] });
  assert.deepEqual(answer.sessions, []);
  const off = await readCameraCardIndex({ target: tmpdir(), devices: [device] });
  assert.equal(off.reason, 'not on a connected drive');
  assert.deepEqual(off.sessions, []);
});

test('a volume with no identity file is seeded by its visible name', async () => {
  const { root } = pretendCard({ 'C0002M01.XML': sidecar('2026-11-20T10:00:00-06:00', 24), 'C0002.MP4': 'x' });
  rmSync(join(root, '.fseventsd'), { recursive: true });
  const answer = await readCameraCardIndex({ target: root, devices: [{ name: 'Plain', mount: root, internal: false }] });
  assert.equal(answer.sessions[0].id, `camera-card:${root.split('/').pop()}:C0002`);
});

test('the tool refuses a call without a volume', async () => {
  await assert.rejects(readCameraCardIndexTool({}, null, { enumerateDevices: async () => [] }), /Say which volume/);
});

test('seedOfSession names its source and clip list with times', () => {
  const start = new Date('2026-11-20T10:00:00Z');
  const seed = seedOfSession({ start, end: new Date('2026-11-20T10:01:00Z'), clips: [{ name: 'C1', path: '/v/C1.MP4', start, seconds: 60, end: new Date('2026-11-20T10:01:00Z') }] }, { volume: 'Card', identity: null });
  assert.equal(seed.id, 'camera-card:Card:C1');
  assert.equal(seed.media.clips[0].seconds, 60);
});

test('the tool row runs a function this module exports, from the connected-drives folder', async () => {
  const { readFileSync } = await import('node:fs');
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const row = rows.find(payload => payload.id === 'tool:read-a-camera-card-index');
  const [, , file, fn] = row.invoke.argv;
  assert.equal(file, '/opt/connected-drives/read-data/camera-card-index.mjs');
  const module = await import('../read-data/camera-card-index.mjs');
  assert.equal(typeof module[fn], 'function');
  assert.deepEqual(row.input_schema.required, ['path']);
});
