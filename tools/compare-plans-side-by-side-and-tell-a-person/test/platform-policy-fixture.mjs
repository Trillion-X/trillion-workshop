import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Supply only caller-owned catalogue DATA with synthetic rows. Actual policy,
// allocation and usage source stays unchanged; production binding is not proved.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/plan-comparison.mjs', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{
    name: 'synthetic-offer-catalogue',
    setup(builder) {
      builder.onResolve({ filter: /commercial-offer-records[.]json$/ }, args => {
        assert.ok(args.importer.endsWith('/tools/shared-code/src/offer-rows.mjs'));
        return { path: 'catalogue', namespace: 'synthetic-offer-catalogue' };
      });
      builder.onLoad({ filter: /^catalogue$/, namespace: 'synthetic-offer-catalogue' }, () => ({
        contents: JSON.stringify({ records: [] }), loader: 'json',
      }));
    },
  }],
});
const actual = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
export const withheldFeature = actual.withheldFeature;
