// tools/make-a-video-playable-at-ingest/do-work/make-a-video-playable-at-ingest.mjs
//
// tool:decide-a-video-at-ingest, run as a function (tools/records-door do-work/run-an-export.mjs): the one decision
// about a video at ingest, by src/ingest-normalization.mjs unchanged. It runs nothing: a runner (a computer's ffmpeg, a
// container) takes plan.args and plan.output_name and does the conversion.
//
//   decideAVideoAtIngest(input) -> { action: 'keep' | 'convert', plan?, said } (src/ingest-normalization.mjs ingestDecision)
//   input: { name, media_type?, byte_length? }
import { convertibleLabels, ingestDecision } from '../src/ingest-normalization.mjs';

export function decideAVideoAtIngest(input = {}) {
  const { name, media_type = '', byte_length } = input ?? {};
  return { ...ingestDecision({ name, media_type, byte_length }), converts: convertibleLabels() };
}
