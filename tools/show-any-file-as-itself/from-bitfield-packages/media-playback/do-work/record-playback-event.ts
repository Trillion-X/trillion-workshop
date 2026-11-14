import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { findMediaSource } from '../../../read-data/read-media-playback.ts';

type RecordPlaybackEventInput = {
  event: unknown;
  media_ref: string;
  published_records: Array<{ payload?: unknown }>;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): RecordPlaybackEventInput {
  if (!isRecord(value)) throw new Error('playback event input must be an object');
  if (typeof value.media_ref !== 'string' || !value.media_ref.trim()) throw new Error('media_ref is required');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  if (!Array.isArray(value.published_records)) throw new Error('published_records must be an array');
  return {
    event: value.event,
    media_ref: value.media_ref,
    published_records: value.published_records as Array<{ payload?: unknown }>,
    target: value.target,
  };
}

export async function recordPlaybackEvent(input: unknown) {
  const request = readInput(input);
  const source = findMediaSource(request.published_records, request.media_ref);
  if (!source) throw new Error(`media source ${request.media_ref} is not published`);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      event: request.event,
      kind: 'media-playback-event',
      media_ref: source.id,
    },
  });
}
