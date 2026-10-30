import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageRoot = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('things-to-store-and-run.json', packageRoot), 'utf8'));
const contract = manifest.things.find((thing) => thing?.payload?.record_kind === 'audio-transcription.result')?.payload;
const pythonProbe = String.raw`
import json, runpy, sys
producer = runpy.run_path(sys.argv[1])
consumer = runpy.run_path(sys.argv[2])
normalize = producer["normalize_whisper_json"]
word_records = consumer["word_records_from_command_output"]
token_result = normalize({"transcription": [{
    "text": "Hello there",
    "timestamps": {"from": "00:00:00.500", "to": "00:00:01.000"},
    "tokens": [
        {"text": " Hello", "start": "00:00:00.000", "end": "00:00:00.300"},
        {"text": " there", "start": "00:00:00.300", "end": "00:00:01.000"}
    ]
}], "result": {"language": "en"}}, "token-request")
estimated_result = normalize({"segments": [{"text": "One two", "start": 3.0, "end": 5.0}]}, "estimate-request")
fallback_result = normalize({"transcription": [{
    "text": "uncertain",
    "timestamps": {"from": "00:00:03.000", "to": "00:00:05.000"},
    "tokens": [{"text": " uncertain", "start": "not-a-time"}]
}]}, "fallback-request")
print(json.dumps({
    "token_command_run_id": token_result["command_run_id"],
    "token_words": token_result["words"],
    "token_records": word_records(token_result["words"]),
    "estimated_words": estimated_result["words"],
    "estimated_records": word_records(estimated_result["words"]),
    "fallback_words": fallback_result["words"],
    "fallback_records": word_records(fallback_result["words"])
}))
`;

test('word timing provenance distinguishes engine tokens from uniform estimates through the real record consumer', () => {
  const output = execFileSync('python3', ['-c', pythonProbe,
    new URL('do-work/process-scripts/transcribe-audio.py', packageRoot).pathname,
    new URL('do-work/process-scripts/make-audio-transcription-records-from-command-output.py', packageRoot).pathname,
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);

  assert.equal(result.token_command_run_id, 'package::audio-transcription::command-run-request::token-request');
  assert.deepEqual(result.token_words.map(({ timing_source }) => timing_source), [
    'engine_token_timestamps', 'engine_token_timestamps',
  ]);
  assert.equal(result.token_words[0].start, 0);
  assert.deepEqual(result.token_records, result.token_words);
  assert.deepEqual(result.estimated_words.map(({ timing_source }) => timing_source), [
    'segment_uniform_estimate', 'segment_uniform_estimate',
  ]);
  assert.deepEqual(result.estimated_records, result.estimated_words);
  assert.deepEqual(result.fallback_words.map(({ timing_source }) => timing_source), ['segment_bounds_fallback']);
  assert.deepEqual(result.fallback_records, result.fallback_words);
  assert.ok(contract.word_shape.optional_fields.includes('timing_source'));
  assert.deepEqual(contract.timing_source_semantics, {
    engine_token_timestamps: 'Both start and end parse from the provider token row; this identifies the timing source and does not assert forced alignment or accuracy.',
    segment_uniform_estimate: 'No token rows were available; the segment duration was divided evenly across its text tokens.',
    segment_bounds_fallback: 'At least one token boundary was unavailable or invalid; a segment boundary supplied the fallback span.',
  });
  const checks = manifest.things.find((thing) => thing?.payload?.kind === 'package-checks-descriptor')?.payload.checks;
  assert.ok(checks.includes('do-work/__tests__/transcribe-audio-word-timing-source.test.mjs'));
});
