// Runs a Workshop row the way the container runner does, against the fake records door: the row's argv with its
// /opt/<folder>/ paths laid on this repository's tools/<folder>/, the input on standard input, and the door's
// descriptor on the row's `invoke.records.fd` with exactly the row's rights. Answers the last JSON line and the
// records the door holds afterwards.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from './fake-door.mjs';

const repository = dirname(fileURLToPath(import.meta.resolve('trillion-workshop/package.json')));
const onThisComputer = word => (typeof word === 'string' && word.startsWith('/opt/') ? join(repository, 'tools', word.slice('/opt/'.length)) : word);

export async function runRow(row, input, { records = [] } = {}) {
  const { argv, records: door = null } = row.invoke;
  const fake = await startFakeDoor({ rights: door?.rights ?? [], mostWrites: door?.most_writes, records });
  try {
    const stdio = ['pipe', 'pipe', 'pipe'];
    if (door) stdio[door.fd] = openSync(fake.descriptor, 'r');
    const [command, ...rest] = argv.map(onThisComputer);
    const answer = await new Promise((done, fail) => {
      const child = spawn(command === 'node' ? process.execPath : command, rest, { stdio });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', fail);
      child.on('close', status => done({ status, ...JSON.parse(out.trim().split('\n').at(-1)) }));
      child.stdin.end(JSON.stringify(input));
    });
    return { ...answer, kept: [...fake.kept.values()], calls: fake.calls };
  } finally { await fake.close(); }
}

/** The row with this id in a tool-rows.json file. */
export const rowOf = (file, id) => file.records.find(record => record.payload.id === id).payload;
