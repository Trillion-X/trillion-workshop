// The clips a pursuit published to its own site, on a real Postgres engine (PGlite): only a row named /published-clips/<hex>.mp4
// with the site use in its surfaces and allowed by the consent fence is answered, newest first, with its files at the site's own
// addresses; a comparison answers its two sides, a reel its cover; nothing private (recording, speaker, path) is answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readSiteClips, siteClipOf } from '../do-work/clips.ts';

const hex = (n: string) => n.repeat(64).slice(0, 64);
const SITE = [{ purpose: 'publish', surface: 'site' }];
async function fresh() {
  const db = new PGlite();
  await db.exec(`create table recording_moment (id text primary key, moment text, recording text, start text, "end" text, published_file_name text, captured_day text, extra text);
    create function material_allowed(text, numeric, numeric, text, text) returns boolean language sql as $$ select $1 <> 'recording/blocked' $$;`);
  const add = (id: string, moment: string, name: string | null, day: string, extra: unknown, recording = 'ok') => db.query('insert into recording_moment values ($1, $2, $3, $4, $5, $6, $7, $8)', [id, moment, recording, '1', '2', name, day, JSON.stringify(extra)]);
  await add('reel-1', 'reel', `/published-clips/${hex('a')}.mp4`, '2026-09-10', { kind: 'reel', aspect: '9x16', surfaces: SITE, why: 'private words' });
  await add('pair-1', 'comparison', `/published-clips/${hex('b')}.mp4`, '2024-07-08', { kind: 'comparison', aspect: '9x16', surfaces: SITE, pair: { left: { person: 'Ada', day: 'May 24, 2023' }, right: { person: 'Ada', day: 'July 8, 2024' } } });
  await add('members-only', 'reel', `/published-clips/${hex('c')}.mp4`, '2026-09-11', { kind: 'reel', surfaces: [{ purpose: 'members', surface: 'members-page' }] });
  await add('blocked', 'reel', `/published-clips/${hex('d')}.mp4`, '2026-09-12', { kind: 'reel', surfaces: SITE }, 'blocked');
  await add('unplaced', 'reel', null, '2026-09-13', { kind: 'reel', surfaces: SITE });
  await add('odd-name', 'reel', '/published-clips/../x.mp4', '2026-09-14', { kind: 'reel', surfaces: SITE });
  return { rows: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[] };
}

test('only a placed, site-published, allowed clip is answered, newest first, with its files at the site\'s own addresses', async () => {
  const { rows } = await fresh();
  const { clips } = await readSiteClips({ database: 'd' }, rows);
  assert.deepEqual(clips.map(clip => clip.id), ['reel-1', 'pair-1']);
  assert.equal(clips[0]!.cut_url, `/published-clips/${hex('a')}.mp4`);
  assert.equal(clips[0]!.picture_url, `/published-clips/${hex('a')}.jpg`);
  assert.equal(clips[0]!.pair, null);
  assert.deepEqual(clips[1]!.pair, { left: { person: 'Ada', day: 'May 24, 2023', picture_url: `/published-clips/${hex('b')}-left.jpg` }, right: { person: 'Ada', day: 'July 8, 2024', picture_url: `/published-clips/${hex('b')}-right.jpg` } });
  assert.equal(clips[1]!.picture_url, null);
  assert.doesNotMatch(JSON.stringify(clips), /private words|recording/);
});

test('a kind narrows the answer, a limit is a whole number, and an unknown kind is refused', async () => {
  const { rows } = await fresh();
  assert.deepEqual((await readSiteClips({ database: 'd', kind: 'comparison' }, rows)).clips.map(clip => clip.id), ['pair-1']);
  assert.equal((await readSiteClips({ database: 'd', limit: 1 }, rows)).clips.length, 1);
  await assert.rejects(readSiteClips({ database: 'd', kind: 'nonsense' as never }, rows), /kind must be one of/);
  await assert.rejects(readSiteClips({ database: 'd', limit: 0 }, rows), /limit/);
});

test('a row with no extra still answers its files', () => {
  const clip = siteClipOf({ id: 'x', moment: 'reel', published_file_name: `/published-clips/${hex('e')}.mp4`, extra: null });
  assert.equal(clip.kind, null);
  assert.equal(clip.cut_url, `/published-clips/${hex('e')}.mp4`);
});
