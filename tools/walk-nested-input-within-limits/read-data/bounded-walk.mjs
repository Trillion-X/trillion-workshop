// Public compatibility entry and JSON command for the canonical bounded walker.
import { boundedWalk, refusalWords } from './bounded-walk-core.mjs';
export * from './bounded-walk-core.mjs';

/** The tool's run: { value, limits? } on standard input -> { result: { ok, nodes } | { ok: false, reason, limit, said } }. */
export function checkNested(input = {}) {
  const result = boundedWalk(input.value ?? null, { limits: input.limits ?? {} });
  return result.ok ? result : { ...result, said: refusalWords(result) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text } = await import('node:stream/consumers');
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: checkNested(input) }));
}
