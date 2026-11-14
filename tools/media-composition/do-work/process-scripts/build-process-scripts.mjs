// Build the media-composition compute.process scripts into bundled .built.mjs artifacts
// that things-to-store-and-run.json ships as `stored_bytes` (mounted by the workflow
// compute steps via blob_ref). `author-concat-edl-cli` bundles the pure `authorConcatEdl`
// (do-work/author-concat-edl.mjs — single SSOT) into one node-ready ESM file with node
// builtins external. THIS MUST BE RE-RUN AFTER ANY author-concat-edl.mjs / -cli change —
// the live compute.process mounts the .built.mjs, NOT the source (L085).
// Run: node packages/media-composition/do-work/process-scripts/build-process-scripts.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// [entryDir, name, ext] — bundle each entry -> sibling .built.mjs.
const SCRIPTS = [[here, 'author-concat-edl-cli', 'mjs']];

for (const [dir, name, ext] of SCRIPTS) {
  const res = await build({
    entryPoints: [dir + name + '.' + ext],
    bundle: true,
    format: 'esm',
    platform: 'node', // keeps node:fs / node:url / node:path external
    target: ['node18'],
    outfile: dir + name + '.built.mjs',
    resolveExtensions: ['.mjs', '.js', '.ts', '.json'],
    metafile: true,
  });
  const out = Object.keys(res.metafile.outputs)[0];
  console.log('built', out, res.metafile.outputs[out].bytes, 'bytes');
}
