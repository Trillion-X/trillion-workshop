import { declaredTestSource } from './declared-test-source.mjs';
import source from './host-source.json' with { type: 'json' };
import iosSource from './ios-source.json' with { type: 'json' };
import { after } from 'node:test';
import { makeHashCodeHexFromJson } from '../tools/content-identity/read-data/identity.mjs';

export const hostTestSource = declaredTestSource(source.binding, source.manifest);
export const hostIosTestSource = declaredTestSource(iosSource.binding, iosSource.manifest);

after(() => {
  for (const source of [hostTestSource, hostIosTestSource]) {
    const { files, dependency_files, ...binding } = source.proof();
    if (files.length) console.info('Declared host source readback', JSON.stringify({ ...binding, consumed_files: files.length,
      consumption_identity: makeHashCodeHexFromJson(files), dependency_files: dependency_files.length,
      dependency_identity: makeHashCodeHexFromJson(dependency_files) }));
  }
});
