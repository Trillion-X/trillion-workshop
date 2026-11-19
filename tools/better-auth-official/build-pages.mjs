// tools/better-auth-official/build-pages.mjs
//
// Purpose: Bundles the sign-in pages' client (pages/sign-in-client.mjs) into pages/assets/sign-in.js. One owner of the build options, used by
// `npm run build-pages` and by the test that checks the bundle is current. The shared parts the client draws live under tools/ui, which has no
// node_modules of its own, so their React import would walk up the folders to whatever node_modules sits above them (the Workshop root holds
// a React of another version): the page would then carry two Reacts, and the alert, which draws through the one the server renderer sets
// up, would throw "Cannot read properties of null (reading 'useRef')" and show no error at all. One resolver sends every import of
// react and react-dom, from any folder, to this tool's copy.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);

const oneReact = {
  name: 'one-react',
  setup(builder) {
    builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, async ({ path, kind, pluginData }) => {
      if (pluginData?.oneReact) return null;
      return builder.resolve(path, { kind, resolveDir: fileURLToPath(here), pluginData: { oneReact: true } });
    });
  },
};

export const options = {
  entryPoints: [fileURLToPath(new URL('pages/sign-in-client.mjs', here))],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  plugins: [oneReact],
  outfile: 'pages/assets/sign-in.js',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(options);
