import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitReaders } from '../../check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../../check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { appDataFolder } from '../do-work/computer-data-folder.mjs';
import contract from '../ports/pr325-computer-data-folder.json' with { type: 'json' };

const ftpSource = readFileSync(new URL('../../receive-files-over-ftp/do-work/send-what-arrives-to-a-namespace.mjs', import.meta.url), 'utf8');
const cameraSource = readFileSync(new URL('../../watch-and-keep-a-live-camera/do-work/receive-a-camera-stream.mjs', import.meta.url), 'utf8');

test('the FTP and camera lifecycles share the process-session app-data owner', () => {
  assert.match(ftpSource, /import\s*\{\s*appDataFolder\s*\}\s*from\s*['"]\.\.\/\.\.\/process-session\/do-work\/computer-data-folder\.mjs['"]/);
  assert.match(ftpSource, /export\s*\{\s*appDataFolder\s*\}/);
  assert.match(ftpSource, /path\.join\(appDataFolder\(\)/);
  assert.match(cameraSource, /import\s*\{\s*appDataFolder\s*\}\s*from\s*['"]\.\.\/\.\.\/process-session\/do-work\/computer-data-folder\.mjs['"]/);
  assert.match(cameraSource, /appData:\s*appDataFolder\(\)/);
});

test('the port contract proves exact source, baseline and one remaining owner', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const readers = gitReaders({ root });
  const result = validateReferenceAdaptationContract(contract, {
    stage: 'completion',
    target: 'tools/process-session/do-work/computer-data-folder.mjs',
    readers,
    repository: 'trillion-workshop',
    retentionAtLeast: 0.6,
    oldCopyDaysAtMost: 3,
  });
  assert.ok(result.valid, JSON.stringify(result));
  assert.deepEqual(result.deferred, []);
});

test('the Workshop source is the exact Trillion source and the old copy is gone', () => {
  const readers = gitReaders({ root: new URL('../../../', import.meta.url).pathname });
  const original = readers.readSource({
    repository: 'trillion',
    commit: '5cd0dc3103e4f54b30b1784f0d77a67de0147064',
    path: 'tools/process-session/do-work/place-data-folder.mjs',
  });
  assert.ok(original);
  assert.equal(makeHashCodeHexFromBytes(original), '1f:95dd9424a177b6ad4b8ada730b3d9481c71303d30cf9b253bbe86db061c9f034');
  assert.equal(readers.lives('trillion', 'tools/process-session/do-work/place-data-folder.mjs'), false);
});

test('app data follows the Mac location, then XDG, then the home data directory', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const xdg = process.env.XDG_DATA_HOME;
  const home = os.homedir();
  const setPlatform = value => Object.defineProperty(process, 'platform', { ...platformDescriptor, value });

  try {
    process.env.XDG_DATA_HOME = '/fixture/xdg-data';
    setPlatform('darwin');
    assert.equal(appDataFolder(), path.join(home, 'Library', 'Application Support'));

    setPlatform('linux');
    assert.equal(appDataFolder(), '/fixture/xdg-data');

    delete process.env.XDG_DATA_HOME;
    assert.equal(appDataFolder(), path.join(home, '.local', 'share'));
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (xdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = xdg;
  }
});
