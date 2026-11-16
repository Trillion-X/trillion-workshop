// tools/keep-the-last-good-answer/do-work/ask-a-web-address.mjs
//
// tool:ask-a-web-address-or-give-the-last-answer: one JSON request on standard input,
//   { address, key, wait_seconds?, last_answer? }
// and { result: { origin, answer, kept_at, to_keep, source_failure, retry_after_seconds, said } } as JSON on the last line.
// A request it cannot answer is refused with { error } and why. It reaches the public web and nothing else.
import { text } from 'node:stream/consumers';
import { askAndKeep } from '../read-data/ask-and-keep.mjs';

try {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: await askAndKeep(input) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
