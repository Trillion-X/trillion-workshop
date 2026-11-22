import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/run-rules-and-schedules-by-themselves/do-work/automation-operations.mjs
//
// The command tool:run-when-something-happens (--kind rule) and tool:run-at-a-time (--kind schedule) run in their
// container. It reads one request on standard input: { operation, input, items, now }, where items is the list the host
// keeps. It writes one JSON line: { answer, items }, where items is the list the host should keep from now on.
//
// Usage: node do-work/automation-operations.mjs --kind rule|schedule < request.json

import { text } from 'node:stream/consumers';
import { runAutomationOperation, AutomationError } from '../src/automation-operations.mjs';

const kindFlag = process.argv.indexOf('--kind');
const kind = kindFlag >= 0 ? process.argv[kindFlag + 1] : undefined;

/** Runs one request and returns { answer, items }. Exported for tests. */
export function answerRequest(request, kindName) {
  const { operation = 'list', input = {}, items = [], now } = request ?? {};
  return runAutomationOperation({ kind: kindName, operation, input: input ?? {}, items: Array.isArray(items) ? items : [], now });
}

async function main() {
  try {
    const request = JSON.parse((await text(process.stdin)) || '{}');
    const { answer, items } = answerRequest(request, kind);
    process.stdout.write(`${JSON.stringify({ answer, items })}\n`);
  } catch (error) {
    const reason = error instanceof AutomationError ? error.reason : 'failed';
    process.stdout.write(`${JSON.stringify({ error: { reason, message: String(error.message ?? error) } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
