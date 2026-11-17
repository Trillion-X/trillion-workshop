// tools/start-a-computer/test/computer-row.test.mjs
//
// A computer runs what its own row says (request.computer_row, a record:computer with `runs`, handed in with the request):
// this tool reads no store for it, and applying or comparing uses that row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAComputerRow, runsOf, computerRowDifferences, readRequest, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const runs = {
  caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' },
  units: [{
    unit: 'example-place.service', template: 'serve-computer', description: 'Example place', user: 'example-place',
    releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
    config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS',
    product_settings: '/var/lib/example-place/product-settings.json', writable: '/var/lib/example-place', drop_ins: ['nofile'],
  }],
  unmanaged: [],
};
const row = { address: '192.0.2.9', name: 'example-computer', os: 'linux', arch: 'x86_64', runs };
const request = { machine: { address: '192.0.2.9' }, ssh: { known_hosts: '/dev/null' }, computer_row: row };

test('a request gets what the computer row it hands in runs, as it is', () => {
  assert.equal(runsOf(request), runs);
});

test('a request may name the computer row as a file beside it: the row is that file\'s JSON', () => {
  const folder = mkdtempSync(join(tmpdir(), 'computer-row-'));
  writeFileSync(join(folder, 'computer.json'), JSON.stringify(row));
  writeFileSync(join(folder, 'request.json'), JSON.stringify({ machine: request.machine, ssh: request.ssh, computer_row_file: 'computer.json' }));
  const read = readRequest(join(folder, 'request.json'));
  assert.deepEqual(runsOf(read), runs);
  assert.equal(read.computer_row_file, undefined);
});

test('a computer row that is an id, a missing value, or has no runs with units and caddy is refused', () => {
  for (const given of ['record:computer:example-computer', undefined, null, {}, { runs: { units: [] } }, { runs: { caddy: {} } }, runs]) {
    assert.throws(() => runsOf({ computer_row: given }), /computer_row is the computer's own row: its `runs` names the units and caddy/);
  }
});

test('applying and comparing a computer use its row: a computer that runs it has no differences', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs, SITE_BLOCK).map(({ path, text }) => [path, text]));
  const run = async (_machine, command) => {
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('if [ -d ')) return 'nofile.conf\n';
    return '';
  };
  assert.deepEqual(await computerRowDifferences(request, { run }), { differences: [] });
  assert.deepEqual(await applyAComputerRow(request, { run }), { written: [], restarted: [] });
  delete live['/etc/caddy/Caddyfile'];
  assert.deepEqual(await computerRowDifferences(request, { run }), { differences: [{ path: '/etc/caddy/Caddyfile', reason: 'missing on the computer' }] });
});
