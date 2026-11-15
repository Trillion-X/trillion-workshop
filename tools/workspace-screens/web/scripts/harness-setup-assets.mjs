// The small executable setup pair is served by the existing public /workspace/ static-asset route. Its payload
// remains the signed Mac app or a pinned checkout; no personal configuration or native account key is published.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

export function writeHarnessSetupAssets({ root, out }) {
  const manifest = JSON.parse(readFileSync(join(root, 'harness', 'setup.json'), 'utf8'));
  if (!/^\/workspace\/[a-z0-9/-]+$/.test(manifest.publication.path) || manifest.publication.path.includes('..')) throw new Error('Harness setup must publish beneath /workspace/.');
  const destination = join(out, manifest.publication.path.slice('/workspace/'.length));
  mkdirSync(destination, { recursive: true });
  const inputs = ['scripts/harness-setup-assets.mjs'];
  // also_served: data the Mac tools read from the service (the standing instructions), not part of the install a person downloads.
  for (const file of [...manifest.publication.files, ...(manifest.publication.also_served ?? [])]) {
    if (!/^[a-z0-9][a-z0-9.-]*\.(?:mjs|json)$/.test(file)) throw new Error('Harness setup publishes only named script and manifest files.');
    const source = `harness/${file}`;
    if (file.endsWith('.mjs')) {
      // The downloaded installer has no adjacent node_modules. Bundle its existing content-identity owner.
      const built = buildSync({ absWorkingDir: root, entryPoints: [source], outfile: join(destination, file), bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true });
      inputs.push(...Object.keys(built.metafile.inputs));
    } else {
      copyFileSync(join(root, source), join(destination, file)); inputs.push(source);
    }
  }
  return inputs;
}
