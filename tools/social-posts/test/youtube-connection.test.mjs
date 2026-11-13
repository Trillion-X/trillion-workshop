// tools/social-posts: the YouTube connection check and the list of the channel's own videos, as tool rows. Each asks
// YouTube with the value the place signs with, on one of the place's hosts, and none names a value.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(HERE, '..', 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const row = id => rows.find(payload => payload.id === id);
const PLACE_HOSTS = ['www.googleapis.com', 'youtube.googleapis.com'];

test('the YouTube connection check asks for the channel the connection signs in as', () => {
  const check = row('tool:check-the-youtube-connection');
  assert.ok(check, 'row exists');
  assert.equal(check.read_only, true);
  assert.equal(check.invoke.kind, 'http');
  assert.equal(check.invoke.method, 'GET');
  assert.equal(check.invoke.url, 'https://www.googleapis.com/youtube/v3/channels');
  assert.deepEqual(check.invoke.query.part, { const: 'id,snippet,contentDetails' });
  assert.deepEqual(check.invoke.query.mine, { const: 'true' });
  assert.deepEqual(check.invoke.connection, { vendor: 'youtube', from_input: 'account_id' });
  assert.deepEqual(check.input_schema.required, ['account_id']);
  assert.equal(check.invoke.credential_injections[0].field_id, 'access_token');
  for (const inj of check.invoke.credential_injections) {
    assert.deepEqual(inj.hosts, ['www.googleapis.com']);
    assert.deepEqual(inj.placement, { kind: 'header', name: 'Authorization', prefix: 'Bearer ' });
  }
});

test('the list of the channel videos reads the uploads playlist, unlisted and private included', () => {
  const list = row('tool:list-my-youtube-videos');
  assert.ok(list, 'row exists');
  assert.equal(list.read_only, true);
  assert.equal(list.invoke.kind, 'http');
  assert.equal(list.invoke.url, 'https://www.googleapis.com/youtube/v3/playlistItems');
  assert.deepEqual(list.invoke.query.part, { const: 'snippet,status,contentDetails' });
  assert.deepEqual(list.invoke.query.playlistId, { from: 'playlist_id' });
  assert.deepEqual(list.invoke.query.pageToken, { from: 'page_token', optional: true });
  assert.deepEqual(list.invoke.connection, { vendor: 'youtube', from_input: 'account_id' });
  assert.deepEqual(list.input_schema.required, ['account_id', 'playlist_id']);
  assert.match(list.description, /unlisted/);
});

test('neither new row names a secret value or a host outside the place hosts', () => {
  for (const id of ['tool:check-the-youtube-connection', 'tool:list-my-youtube-videos']) {
    assert.doesNotMatch(JSON.stringify(row(id)), /ya29\.|refresh_token=|client_secret/);
    for (const inj of row(id).invoke.credential_injections) {
      for (const host of inj.hosts) assert.ok(PLACE_HOSTS.includes(host));
    }
  }
});

test('the comment reader asks for one video\'s top-level threads, read only, page by page', () => {
  const read = row('tool:read-youtube-comments');
  assert.ok(read, 'row exists');
  assert.equal(read.read_only, true);
  assert.equal(read.invoke.kind, 'http');
  assert.equal(read.invoke.method, 'GET');
  assert.equal(read.invoke.url, 'https://www.googleapis.com/youtube/v3/commentThreads');
  assert.deepEqual(read.invoke.query.part, { const: 'snippet' });
  assert.deepEqual(read.invoke.query.videoId, { from: 'video_id' });
  assert.deepEqual(read.invoke.query.pageToken, { from: 'page_token', optional: true });
  assert.doesNotMatch(read.invoke.query.fields.const, /authorDisplayName|authorProfileImageUrl/);
  assert.match(read.invoke.query.fields.const, /authorChannelId/);
  assert.deepEqual(read.invoke.query.maxResults, { const: '100' });
  assert.deepEqual(read.invoke.connection, { vendor: 'youtube', from_input: 'account_id' });
  assert.deepEqual(read.input_schema.required, ['account_id', 'video_id']);
  assert.equal(read.invoke.credential_injections[0].field_id, 'access_token');
  for (const inj of read.invoke.credential_injections) {
    assert.deepEqual(inj.hosts, ['www.googleapis.com']);
  }
  assert.doesNotMatch(JSON.stringify(read), /ya29\.|refresh_token=|client_secret=|\bkey=/);
  assert.match(read.description, /posts, rates and moderates nothing/i);
});
