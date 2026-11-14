// Build the Stripe ingest compute.process scripts into bundled .built.mjs artifacts
// that things-to-store-and-run.json ships as `stored_bytes` (mounted by the workflow
// compute steps via blob_ref). Each bundles its .mjs entry — inlining the SSOT
// process modules (parse-stripe-signature / compare-and-map-stripe-webhook ->
// map-stripe-webhook-event) — into one node-ready ESM file with node builtins external.
// Run: node packages/stripe-payment-provider/do-work/process-scripts/build-process-scripts.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const processDir = fileURLToPath(new URL('../../process/', import.meta.url));

// [entryDir, name] — bundle each .mjs entry -> sibling .built.mjs.
// The capability worker lives in process/ (not process-scripts/) and is mounted
// by start-checkout / read-checkout-session via blob_ref + `--input-json`, same as
// the ingest CLIs — so it must be bundled standalone too.
const SCRIPTS = [
  [here, 'parse-stripe-signature-cli'],
  [here, 'compare-and-map-stripe-cli'],
  [processDir, 'stripe-capability-worker'],
  [processDir, 'build-stripe-http-request'],
];

for (const [dir, name] of SCRIPTS) {
  const res = await build({
    entryPoints: [dir + name + '.mjs'],
    bundle: true,
    format: 'esm',
    platform: 'node', // keeps node:fs / node:url / node:crypto external
    target: ['node18'],
    outfile: dir + name + '.built.mjs',
    metafile: true,
  });
  const out = Object.keys(res.metafile.outputs)[0];
  console.log('built', out, res.metafile.outputs[out].bytes, 'bytes');
}
