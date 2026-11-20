// tools/build-engine-modules-for-web-hosts/test/committed-bytes-without-sibling-crates.test.mjs
//
// A Workshop exported alone (as a computer's apply runs it) has no engine crates beside it, so the committed modules'
// sources cannot be read there. Such a Workshop admits the committed modules by their own bytes: each file's BLAKE3 must
// be the one fingerprint.json records, also when a folder of the engine's name beside it is not its repository. A file whose
// bytes differ is refused, and nothing tries to build it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_TOOL, BUILT_CRATES_FOLDER } from '../build/compiled-modules.mjs';

const recorded = JSON.parse(readFileSync(join(BUILT_CRATES_FOLDER, 'fingerprint.json'), 'utf8'));

test('a Workshop with no sibling crates admits the committed modules by their recorded BLAKE3, and refuses a changed byte',
  { skip: !recorded.files && 'fingerprint.json records no file identities yet (build-compiled-modules.mjs writes them)' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'workshop-alone-'));
    try {
      // A Workshop holding only this tool and what its build folder imports, with nothing beside it.
      const workshop = join(root, 'workshop');
      const tool = join(workshop, 'tools', 'build-engine-modules-for-web-hosts');
      cpSync(join(BUILD_TOOL, 'build'), join(tool, 'build'), { recursive: true });
      cpSync(BUILT_CRATES_FOLDER, join(tool, 'built-stored-bytes'), { recursive: true });
      cpSync(join(BUILD_TOOL, '..', 'process-session'), join(workshop, 'tools', 'process-session'), { recursive: true });
      symlinkSync(join(BUILD_TOOL, '..', '..', 'node_modules'), join(workshop, 'node_modules'));
      const alone = await import(pathToFileURL(join(tool, 'build', 'compiled-modules.mjs')).href);
      assert.ok(recorded.crate_dirs.some(dir => dir.startsWith('../')), 'the modules are built from a crate beside the Workshop');
      assert.equal(await alone.committedModulesCurrent(), true);
      assert.equal(await alone.withCommittedModules(admitted => admitted.fingerprint), recorded.fingerprint);
      // A folder beside it under the engine's name that is not the engine's repository (an apply's /tmp held one, Nov 20 2026)
      // cannot answer for the recorded commit either: the bytes still decide.
      mkdirSync(join(root, 'trillion-rust', 'crates'), { recursive: true });
      assert.equal(await alone.committedModulesCurrent(), true);

      const [file] = Object.keys(recorded.files);
      const bytes = readFileSync(join(tool, 'built-stored-bytes', file));
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(join(tool, 'built-stored-bytes', file), bytes);
      assert.equal(await alone.committedModulesCurrent(), false);
      await assert.rejects(alone.withCommittedModules(() => 'read'), /not the bytes their fingerprint\.json records/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
