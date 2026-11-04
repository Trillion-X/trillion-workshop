// tools/tell-ais-how-to-act/do-work/keep-standing-instructions.mjs
//
// tool:keep-trillion-in-your-instructions: keeps the standing instructions as one marked block in the person's own AI
// harness instruction file. Reads { harness, action, text? } on standard input and prints the report. The input check
// is moved from Trillion-X/trillion computer/harness-instructions.mjs (makeInstructionTools); that Mac tool also
// fetched the service's current words from a fixed address, which is left out: a caller passes `text`, else the copy
// in read-data is used. The file work is ./standing-instructions.mjs: one marked block, every other byte left alone.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harnessIds, keepInstructions } from './standing-instructions.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Checks the input the way the Mac tool did (plus an optional `text`) and answers the result record. */
export function keep(input, { run = keepInstructions, now = () => new Date().toISOString() } = {}) {
  if (!object(input) || Object.keys(input).some(name => !['harness', 'action', 'text'].includes(name)) || !harnessIds().includes(input.harness) ||
    !['inspect', 'apply', 'remove'].includes(input.action) || (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim()))) {
    throw new Error(`Name one supported harness (${harnessIds().join(', ')}) and inspect, apply or remove.`);
  }
  const text = input.action === 'apply' || input.action === 'inspect' ? input.text ?? null : null;
  const report = run({ action: input.action, harness: input.harness, ...(text ? { text } : {}) });
  return { schema: 'trillion.standing-instructions-result/v1', observed_at: now(), text_from: text ? 'caller' : 'this tool', report };
}

const isEntryScript = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isEntryScript()) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try { process.stdout.write(`${JSON.stringify(keep(JSON.parse(raw || '{}')))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(2); }
}
