// Tests for a surface input's media record (read-data/read-surface-media.ts). The refs are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSurfaceMedia } from '../read-data/read-surface-media.ts';

test('a value that is not a record, or names no address, is no media: the surface shows its empty state', () => {
  assert.equal(readSurfaceMedia(undefined), undefined);
  assert.equal(readSurfaceMedia('https://files.example.test/walk.mp4'), undefined);
  assert.equal(readSurfaceMedia([{ playback_url: 'https://files.example.test/walk.mp4' }]), undefined);
  assert.equal(readSurfaceMedia({ label: 'Walk' }), undefined);
});

test('a bare address with no id plays: its id is the first address field present, and it is a video', () => {
  const media = readSurfaceMedia({ embed_url: 'https://www.youtube-nocookie.com/embed/abc123', source_url: 'https://files.example.test/x.mp4' });
  assert.equal(media.id, 'https://www.youtube-nocookie.com/embed/abc123');
  assert.equal(media.embed_url, 'https://www.youtube-nocookie.com/embed/abc123');
  assert.equal(readSurfaceMedia({ playback_url: 'https://files.example.test/walk.mp4' }).source_kind, 'video');
});

test('a full record keeps its own id and an address with a declared kind keeps that kind', () => {
  const media = readSurfaceMedia({ id: 'lesson:1', playback_url: 'https://files.example.test/talk.m4a', source_kind: 'audio', label: 'Talk' });
  assert.equal(media.id, 'lesson:1');
  assert.equal(media.source_kind, 'audio');
  assert.equal(media.label, 'Talk');
});

test('the fields the player needs to hide native captions and show the transcript survive: embed_control, embed_control_ref, transcript_ref', () => {
  const media = readSurfaceMedia({
    id: 'lesson:2',
    embed_url: 'https://www.youtube-nocookie.com/embed/abc123',
    embed_control: { id: 'youtube', commands: { cc_load_policy: 0 } },
    embed_control_ref: 'control:youtube',
    transcript_ref: 'transcript:lesson-2',
  });
  assert.deepEqual(media.embed_control.commands, { cc_load_policy: 0 });
  assert.equal(media.embed_control_ref, 'control:youtube');
  assert.equal(media.transcript_ref, 'transcript:lesson-2');
});
