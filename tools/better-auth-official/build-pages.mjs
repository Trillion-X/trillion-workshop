// tools/better-auth-official/build-pages.mjs
//
// Purpose: Bundles the sign-in pages' client (pages/sign-in-client.mjs) into pages/assets/sign-in.js. One owner of the build options, used by
// `npm run build-pages` and by the test that checks the bundle is current. The shared parts the client draws live under tools/ui, which has no
// node_modules of its own, so their React import would walk up the folders to whatever node_modules sits above them (the Workshop root holds
// a React of another version): the page would then carry two Reacts, and the alert, which draws through the one the server renderer sets
// up, would throw "Cannot read properties of null (reading 'useRef')" and show no error at all. One resolver sends every import of
// react and react-dom, from any folder, to this tool's copy.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
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

// The terminal's busy sentence is read from its own DATA at build time and handed to the pages as one module, so the bundle holds that sentence
// only and no second copy of it lives in this tool.
const commandWords = JSON.parse(readFileSync(new URL('../use-your-tools-from-a-shell/do-work/command.json', here), 'utf8')).words;
const busySentence = {
  name: 'sign-in-busy-sentence',
  setup(builder) {
    builder.onResolve({ filter: /^sign-in-busy-sentence$/ }, () => ({ path: 'sign-in-busy-sentence', namespace: 'busy' }));
    builder.onLoad({ filter: /.*/, namespace: 'busy' }, () => ({ contents: `export default ${JSON.stringify(commandWords.sign_in_busy)};`, loader: 'js' }));
  },
};

export const options = {
  entryPoints: [fileURLToPath(new URL('pages/sign-in-client.mjs', here))],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  plugins: [oneReact, busySentence],
  outfile: 'pages/assets/sign-in.js',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(options);
