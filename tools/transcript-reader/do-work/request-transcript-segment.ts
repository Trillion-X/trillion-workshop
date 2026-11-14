import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { readTranscriptSegments, type PublishedRecord } from '../read-data/read-transcript-records';

type RequestTranscriptSegmentInput = {
  published_records: PublishedRecord[];
  segment_id: string;
  target: string;
  transcript_ref: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): RequestTranscriptSegmentInput {
  if (!isRecord(value)) throw new Error('transcript segment request input must be an object');
  if (typeof value.segment_id !== 'string' || !value.segment_id.trim()) throw new Error('segment_id is required');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  if (typeof value.transcript_ref !== 'string' || !value.transcript_ref.trim()) throw new Error('transcript_ref is required');
  if (!Array.isArray(value.published_records)) throw new Error('published_records must be an array');
  return {
    published_records: value.published_records as PublishedRecord[],
    segment_id: value.segment_id,
    target: value.target,
    transcript_ref: value.transcript_ref,
  };
}

export async function requestTranscriptSegment(input: unknown) {
  const request = readInput(input);
  const segment = readTranscriptSegments(request.published_records, request.transcript_ref)
    .find((candidate) => candidate.id === request.segment_id);
  if (!segment) throw new Error(`transcript segment ${request.segment_id} is not published`);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      kind: 'transcript-segment-request',
      segment,
    },
  });
}
