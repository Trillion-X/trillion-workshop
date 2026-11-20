// tools/start-a-computer/test/computer-row.test.mjs
//
// A computer runs what its own row says (request.computer_row, a record:computer with `runs`, handed in with the request):
// this tool reads no store for it, and applying or comparing uses that row.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAComputerRow, runsOf, computerRowDifferences, readRequest } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const runs = {
  health_listen: '127.0.0.1:7199',
  units: [{
    unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-place', drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'],
  }],
  unmanaged: [],
};
const row = { address: '192.0.2.9', name: 'example-computer', os: 'linux', arch: 'x86_64', runs };
const request = { machine: { address: '192.0.2.9' }, ssh: { known_hosts: '/dev/null' }, computer_row: row };

test('a request gets what the computer row it hands in runs, as it is', () => {
  assert.equal(runsOf(request), runs);
});

test('a request may name the computer row as a file beside it: the row is that file\'s JSON', () => {
  const folder = tempFolder(join(tmpdir(), 'computer-row-'));
  writeFileSync(join(folder, 'computer.json'), JSON.stringify(row));
  writeFileSync(join(folder, 'request.json'), JSON.stringify({ machine: request.machine, ssh: request.ssh, computer_row_file: 'computer.json' }));
  const read = readRequest(join(folder, 'request.json'));
  assert.deepEqual(runsOf(read), runs);
  assert.equal(read.computer_row_file, undefined);
});

test('a computer row that is an id, a missing value, or has no runs with units is refused', () => {
  for (const given of ['record:computer:example-computer', undefined, null, {}, { runs: { health_listen: '127.0.0.1:7199' } }, runs]) {
    assert.throws(() => runsOf({ computer_row: given }), /computer_row is the computer's own row: its `runs` names the units/);
  }
});

test('applying and comparing a computer use its row: a computer that runs it has no differences', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const run = async (_machine, command) => {
    // A set-up computer's firewall admits the settings' ports.
    if (command.startsWith('ufw status')) return 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
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
  delete live['/etc/example-place/computer.json'];
  assert.deepEqual(await computerRowDifferences(request, { run }), { differences: [{ path: '/etc/example-place/computer.json', reason: 'missing on the computer' }] });
});

// A pages folder may hold a link to a folder kept elsewhere (a site's own repository): its files are read through the link,
// named by where they sit in the pages folder, never copied there first.
test('the pages folder follows a link to a folder kept elsewhere', async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { readPages } = await import('../do-work/start-a-computer.mjs');
  const kept = tempFolder(`${tmpdir()}/kept-`), pages = tempFolder(`${tmpdir()}/pages-`);
  mkdirSync(`${kept}/assets`);
  writeFileSync(`${kept}/index.html`, '<p>home</p>');
  writeFileSync(`${kept}/assets/site.css`, 'body{}');
  symlinkSync(kept, `${pages}/place.example.test`);
  const read = readPages({ pages_folder: pages }).map(({ name, bytes }) => [name, bytes.toString()]).sort();
  assert.deepEqual(read, [['place.example.test/assets/site.css', 'body{}'], ['place.example.test/index.html', '<p>home</p>']]);
});
