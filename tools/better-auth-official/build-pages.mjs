// tools/better-auth-official/build-pages.mjs
//
// Purpose: Bundles the sign-in pages' client (pages/sign-in-client.mjs) into pages/assets/sign-in.js. One owner of the build options, used by
// `npm run build-pages` and by the test that checks the bundle is current. The shared parts the client draws live under tools/ui, which has no
// node_modules of its own, so their React import resolves in this tool's node_modules (nodePaths).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);

export const options = {
  entryPoints: [fileURLToPath(new URL('pages/sign-in-client.mjs', here))],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  nodePaths: [fileURLToPath(new URL('node_modules', here))],
  outfile: 'pages/assets/sign-in.js',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(options);
