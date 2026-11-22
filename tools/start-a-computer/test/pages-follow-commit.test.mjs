// tools/start-a-computer/test/pages-follow-commit.test.mjs
//
// A unit that declares `pages_hosts` is applied only when each host's link in the request's pages_folder points into the
// unit's `source.commit`, so its pages and the program that serves them switch together. The check runs before any write.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAComputerRow } from '../do-work/start-a-computer.mjs';

const COMMIT = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const HOST = 'site.example.com';

// The unit as the computer row names it; `pages_hosts` is added only when given (a unit without the field is unaffected).
const unit = (commit = COMMIT, pages_hosts) => ({
  unit: 'example-site.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example site', user: 'example-site',
  state: '/var/lib/example-site', builds: '/var/lib/example-site/builds', program: 'example-engine', settings_file: '/etc/example-site/computer.json',
  settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-site', source: { commit },
  ...(pages_hosts === undefined ? {} : { pages_hosts }),
});

const request = (units, pages_folder) => ({
  machine: { address: '192.0.2.41', name: 'example-site' }, ssh: { known_hosts: '/dev/null' },
  computer_row: { address: '192.0.2.41', name: 'example-site', runs: { health_listen: '127.0.0.1:7199', units, unmanaged: [] } },
  ...(pages_folder === undefined ? {} : { pages_folder }),
});

// A folder of per-host links: each host's link points at a built folder named with the commit it was built from.
function pagesFolder(links) {
  const folder = tempFolder(join(tmpdir(), 'pages-follow-commit-'));
  for (const [host, built] of Object.entries(links)) {
    mkdirSync(join(folder, 'built', built), { recursive: true });
    symlinkSync(join(folder, 'built', built), join(folder, host));
  }
  return folder;
}

// A run that stands for the first remote step: reaching it means every check before the apply passed.
const reached = new Error('reached the computer');
function recordingRun() {
  const calls = [];
  const run = async (...args) => { calls.push(args); throw reached; };
  return { calls, run };
}

test('a host whose link points into the unit\'s source.commit applies: the first remote step is reached', async () => {
  const { calls, run } = recordingRun();
  const folder = pagesFolder({ [HOST]: `site-${COMMIT}/public` });
  await assert.rejects(applyAComputerRow(request([unit(COMMIT, [HOST])], folder), { run }), err => err === reached);
  assert.equal(calls.length, 1);
});

test('a host whose link points at another commit refuses before any remote step', async () => {
  const { calls, run } = recordingRun();
  const folder = pagesFolder({ [HOST]: `site-${OTHER}/public` });
  await assert.rejects(applyAComputerRow(request([unit(COMMIT, [HOST])], folder), { run }),
    new RegExp(`${HOST} pages: .*site-${OTHER}/public, not example-site\\.service's source\\.commit ${COMMIT}\\. Apply refused before any write\\.`));
  assert.equal(calls.length, 0);
});

test('a host with no link in pages_folder refuses before any remote step', async () => {
  const { calls, run } = recordingRun();
  const folder = pagesFolder({});
  await assert.rejects(applyAComputerRow(request([unit(COMMIT, [HOST])], folder), { run }),
    new RegExp(`${HOST} has no link at .*${HOST} in pages_folder; example-site\\.service pages_hosts needs it to point at source\\.commit ${COMMIT}\\.`));
  assert.equal(calls.length, 0);
});

test('pages_hosts with no pages_folder in the request refuses before any remote step', async () => {
  const { calls, run } = recordingRun();
  await assert.rejects(applyAComputerRow(request([unit(COMMIT, [HOST])]), { run }),
    /example-site\.service pages_hosts names site\.example\.com: the request needs pages_folder/);
  assert.equal(calls.length, 0);
});

test('a host name that is not a plain host name refuses before any remote step', async () => {
  const { calls, run } = recordingRun();
  const folder = pagesFolder({ [HOST]: `site-${COMMIT}/public` });
  await assert.rejects(applyAComputerRow(request([unit(COMMIT, ['../site.example.com'])], folder), { run }),
    /example-site\.service pages_hosts is a list of host names\./);
  assert.equal(calls.length, 0);
});

test('pages_hosts without a full source.commit refuses before any remote step', async () => {
  const { calls, run } = recordingRun();
  const folder = pagesFolder({ [HOST]: `site-${COMMIT}/public` });
  await assert.rejects(applyAComputerRow(request([unit('main', [HOST])], folder), { run }),
    /example-site\.service pages_hosts needs source\.commit, the full commit id/);
  assert.equal(calls.length, 0);
});

test('a unit without pages_hosts is not checked: a link at another commit does not stop its apply', async () => {
  const { run } = recordingRun();
  const folder = pagesFolder({ [HOST]: `site-${OTHER}/public` });
  await assert.rejects(applyAComputerRow(request([unit(COMMIT)], folder), { run }), err => err === reached);
});
