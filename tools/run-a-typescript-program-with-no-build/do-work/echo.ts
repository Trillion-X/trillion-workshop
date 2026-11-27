// tools/run-a-typescript-program-with-no-build/do-work/echo.ts
//
// The container tool `tool:run-a-typescript-program-with-no-build` (what-this-tool-does-and-how-to-run-it.json): proves that a tool's program can be
// TypeScript that the engine's pinned Node runs as it is, with nothing built and nothing committed. Node strips the types
// (erasable syntax only: no enum, no namespace, no parameter properties), so this file is the program the run starts.
//
// It reads one JSON object on standard input and answers, on standard output, the words it was given, the Node that ran it,
// and whether that Node strips types itself.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface EchoInput {
  words: string;
}

export interface EchoAnswer {
  words: string;
  node: string;
  types_stripped: boolean;
}

const MOST_CHARS = 4000;

export function echo(input: unknown): EchoAnswer {
  const words = (input as Partial<EchoInput> | null)?.words;
  if (typeof words !== 'string' || words.length === 0 || words.length > MOST_CHARS) {
    throw new TypeError(`The input is {"words": "..."}: text of 1 to ${MOST_CHARS} characters.`);
  }
  // `process.features.typescript` is "strip" when this Node strips types by default (Node 23.6 and later).
  const stripped: boolean = process.features.typescript === 'strip' || process.features.typescript === 'transform';
  return { words, node: process.version, types_stripped: stripped };
}

const started = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url; } catch { return false; } })();
if (started) {
  try {
    const answer: EchoAnswer = echo(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(`${JSON.stringify({ result: answer })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: { message: (error as Error).message } })}\n`);
    process.exitCode = 1;
  }
}
