// tools/media-composition/test/local-image-rows.test.mjs: the two MFLUX picture rows are declared again. Each runs its app
// through tool:run-an-app-job on the person's own Mac, names an app the do-work/apps-here.json declares, and that job owner
// is declared in run-on-a-persons-computer's mac-tools.json. Moved from an older repository's records by
// 48da049bf, which lost them from this folder; this pins them so a later edit cannot drop them silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(readFileSync(file, 'utf8'));

test('the two MFLUX picture rows run their app through the app-job owner', () => {
  const rows = read(join(folder, 'what-this-tool-does-and-how-to-run-it.json')).records.map(record => record.payload);
  const apps = read(join(folder, 'do-work', 'apps-here.json')).apps.map(app => app.id);
  const owner = read(join(folder, '..', 'run-on-a-persons-computer', 'mac-tools.json'));
  assert.ok(owner.tools['tool:run-an-app-job'], 'the app-job owner is declared');
  for (const id of ['tool:generate-local-image', 'tool:edit-local-image']) {
    const row = rows.find(payload => payload.id === id);
    assert.ok(row, `${id} is declared`);
    assert.equal(row.invoke.tool_id, 'tool:run-an-app-job');
    assert.ok(apps.includes(row.invoke.input.app), `${row.invoke.input.app} is declared in apps-here.json`);
    assert.ok(existsSync(join(folder, 'kits', `${id.slice('tool:'.length)}.json`)), `${id} has its kit`);
  }
});
