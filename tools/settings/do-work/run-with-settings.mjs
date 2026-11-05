// tools/settings/do-work/run-with-settings.mjs
//
// Runs a tool's program with the settings row it names read through the run's records door. Reads the request on
// stdin; when `settings_record` is a row's id (record:setting:<folder>~<scope_kind>~<scope_id>), reads that row
// (descriptor 3) and hands the program the request with `settings_record` replaced by the record itself
// ({ id, type, value }) and `settings_from` naming it. The program then reads it with read-data/settings.py
// request_settings(request, defaults) or settings.mjs settingsFor. Anything else reaches the program unchanged. The
// program's output is passed through as it is, so the row's result_selector reads it unchanged.
//
//   node /opt/settings/do-work/run-with-settings.mjs --folder <workshop-folder> -- <program> [args...]  < request.json
import { spawn } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { isSettingId, readSettingRecord, SettingError, LIST_ID } from '../read-data/settings.mjs';

async function openDoor() {
  const { openRecordsDoor } = await import(new URL('../../records-door/read-data/records-door.mjs', import.meta.url).href);
  return openRecordsDoor();
}

export async function runWithSettings(argv, { stdin = process.stdin, door: givenDoor, out = process.stdout } = {}) {
  const at = argv.indexOf('--');
  const options = at < 0 ? argv : argv.slice(0, at);
  const program = at < 0 ? [] : argv.slice(at + 1);
  const folderAt = options.indexOf('--folder');
  const folder = folderAt >= 0 ? options[folderAt + 1] : undefined;
  if (!folder || !program.length) throw new SettingError('usage: run-with-settings.mjs --folder <workshop-folder> -- <program> [args...] < request.json');
  const request = JSON.parse((await text(stdin)) || '{}');
  let handed = request;
  if (isSettingId(request.settings_record)) {
    const record = await readSettingRecord(givenDoor ?? await openDoor(), request.settings_record, { folder });
    if (!record) throw new SettingError(`No ${request.settings_record} in ${LIST_ID}: write the row first, or leave settings_record out to run on the defaults.`);
    handed = { ...request, settings_record: record, settings_from: { id: record.id, from: record.value.from ?? null } };
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(program[0], program.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.on('data', chunk => out.write(chunk));
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
    child.stdin.end(JSON.stringify(handed));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await runWithSettings(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
