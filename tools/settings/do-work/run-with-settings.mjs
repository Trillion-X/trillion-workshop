// tools/settings/do-work/run-with-settings.mjs
//
// Runs a tool's program with its settings read: reads the request on stdin, and when it names `settings_record`,
// reads that row of list:settings through the run's records door (descriptor 3), lays its `settings` under the
// request's own `settings`, and hands the program the request with `settings` merged and `settings_from` set. The
// program's last line is printed as it is, so the row's result_selector reads it unchanged.
//
//   node /opt/settings/do-work/run-with-settings.mjs --folder <workshop-folder> -- <program> [args...]  < request.json
import { spawn } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { settingsFor } from '../read-data/settings.mjs';

export async function runWithSettings(argv, { stdin = process.stdin, door: givenDoor, out = process.stdout } = {}) {
  const at = argv.indexOf('--');
  const options = at < 0 ? argv : argv.slice(0, at);
  const program = at < 0 ? [] : argv.slice(at + 1);
  const folderAt = options.indexOf('--folder');
  const folder = folderAt >= 0 ? options[folderAt + 1] : undefined;
  if (!folder || !program.length) throw new Error('usage: run-with-settings.mjs --folder <workshop-folder> -- <program> [args...] < request.json');
  const request = JSON.parse((await text(stdin)) || '{}');
  let handed = request;
  if (request.settings_record !== undefined || request.settings !== undefined) {
    const door = request.settings_record !== undefined ? (givenDoor ?? openRecordsDoor()) : undefined;
    const { settings, from } = await settingsFor(request, { door, folder });
    const { settings_record: _, ...rest } = request;
    handed = { ...rest, settings, ...(from ? { settings_from: from } : {}) };
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(program[0], program.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.on('data', chunk => out.write(chunk));
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
    child.stdin.end(JSON.stringify(handed));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await runWithSettings(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
