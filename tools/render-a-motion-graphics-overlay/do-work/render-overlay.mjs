// tools/render-a-motion-graphics-overlay/do-work/render-overlay.mjs
//
// The row's command. Reads the request on stdin and runs the renderer, which lays the film's look (`settings_record`,
// the person's look row handed as the record itself) under the request's own `settings` (settings.request_settings). The
// person's AI reads the look row and the piece's row from their store and gives them: the look as `settings_record`
// ({ id, type, value }), the piece's `settings.spec` as `spec`. No records door is opened and nothing is kept. The
// program's output is printed unchanged.
//
//   node do-work/render-overlay.mjs < request.json
import { spawn } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSettingId } from '../../settings/read-data/settings.mjs';
import { realpathSync } from 'node:fs';

export const FOLDER = 'render-a-motion-graphics-overlay';
const here = dirname(fileURLToPath(import.meta.url));

export class OverlayRequestError extends Error {}

/** Refuses a row named by its id: the row itself is what the request carries. */
export function refuseRowIds(request, names) {
  for (const name of names) {
    if (isSettingId(request?.[name])) throw new OverlayRequestError(`${name} is a row's id: give the row itself, { id, type, value }, as your AI read it from your settings table.`);
  }
}

/** The request, once it holds its spec. */
export function withSpec(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new OverlayRequestError('The request must be one JSON object.');
  if (request.spec_record !== undefined) throw new OverlayRequestError("spec_record is not read here: give the piece row's settings.spec as spec.");
  if (request.spec === undefined) throw new OverlayRequestError("Give the spec (a piece row's settings.spec).");
  return request;
}

/** Runs the renderer on the request as handed and passes its output through as it is; resolves to its exit code. */
export function runProgram(program, handed, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(program[0], program.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.on('data', chunk => out.write(chunk));
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
    child.stdin.end(JSON.stringify(handed));
  });
}

export async function renderOverlay({ stdin = process.stdin, out = process.stdout, python = 'python3' } = {}) {
  const request = JSON.parse((await text(stdin)) || '{}');
  refuseRowIds(request, ['settings_record']);
  const handed = withSpec(request);
  return runProgram([python, join(here, 'render_a_motion_graphics_overlay.py')], handed, out);
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  try {
    process.exitCode = await renderOverlay();
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
