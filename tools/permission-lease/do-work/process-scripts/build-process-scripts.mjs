// Build the permission-lease compute.process scripts into bundled .built.mjs
// artifacts that things-to-store-and-run.json ships as `stored_bytes` (mounted
// by the workflow compute steps via blob_ref). `obligation-decision-cli`
// bundles the pure `decideCapability` leaf + its predicate op map into one
// node-ready ESM file with node builtins external. THIS MUST BE RE-RUN AFTER
// ANY obligation-decision.ts / obligation-decision-cli.ts change — the live
// compute.process mounts the .built.mjs, NOT the .ts source (L085).
// Run: node packages/permission-lease/do-work/process-scripts/build-process-scripts.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// Repo root — the `@/` import alias used across the packages resolves to it.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const SCRIPTS = [
  // Obligation-gated capability access: evaluate capability-obligation records
  // against measure facts and emit the obligation-decision fact.
  [here, 'obligation-decision-cli', 'ts'],
];

for (const [dir, name, ext] of SCRIPTS) {
  const res = await build({
    entryPoints: [dir + name + '.' + ext],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node18'],
    outfile: dir + name + '.built.mjs',
    alias: { '@': repoRoot.replace(/\/$/, '') },
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    metafile: true,
  });
  const out = Object.keys(res.metafile.outputs)[0];
  console.log('built', out, res.metafile.outputs[out].bytes, 'bytes');
}
