// tools/reply-templates/do-work/expand-a-reply-template.mjs
//
// tool:expand-a-reply-template: one JSON request on standard input, { template?, provider_record?, caller_request?, data? },
// and { result: { reply } } as JSON on the last line. A request it cannot expand is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { expandReplyTemplate } from '../read-data/expand.mjs';

try {
  console.log(JSON.stringify({ result: { reply: expandReplyTemplate(JSON.parse((await text(process.stdin)) || '{}')) } }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
