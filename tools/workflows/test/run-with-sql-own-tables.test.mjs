// A tool outside this folder makes its own tables: `--sql FOLDER` on the entry's argv applies that folder after this folder's sql/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDatabase } from '../test-helpers/rows-in-sql.mjs';

const here = path => fileURLToPath(new URL(path, import.meta.url));
const run = (db, args, request) => new Promise(done => {
  const child = spawn(process.execPath, [here('../do-work/run-with-sql.mjs'), ...args], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stdio[3].end(db.connection);
  child.stdin.end(JSON.stringify(request));
  child.on('close', code => done({ code, last: JSON.parse(out.trim().split('\n').at(-1)) }));
});

test('the entry makes the tables of the folders named by --sql, and refuses an argument it does not know', async () => {
  const db = await startDatabase();
  try {
    const module = here('../test-helpers/made-up-own-tables/count-widgets.mjs');
    const own = here('../test-helpers/made-up-own-tables/sql');
    const first = await run(db, [module, 'countWidgets', '--sql', own], { input: { id: 'a' } });
    assert.deepEqual(first.last, { result: { n: 1 } });
    const again = await run(db, [module, 'countWidgets', '--sql', own], { input: { id: 'a' } });
    assert.deepEqual(again.last, { result: { n: 1 } });
    const unknown = await run(db, [module, 'countWidgets', '--other', own], { input: { id: 'a' } });
    assert.equal(unknown.code, 1);
    assert.match(unknown.last.error, /usage/);
  } finally { await db.stop(); }
});
