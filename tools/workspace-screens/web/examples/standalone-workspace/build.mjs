// examples/standalone-workspace/build.mjs
//
// Builds the standalone example page with esbuild, the way the Workshop's workspace build bundles its page script: the
// arrangement's compiled math and the composition engine's bytes are the committed modules (tools/build-engine-modules-for-web-hosts),
// served as files beside the page. Output: the folder named by the first argument, or a folder in the system temp folder.
//   node tools/workspace-screens/web/examples/standalone-workspace/build.mjs [outDir]
// buildPage({ entry, out }) builds any page entry the same way (the records test builds its own entry this way).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { workshopShellImportsPlugin } from '../../../../workspace-pieces/scripts/workshop-shell-imports.mjs';
import { partSideEffectsPlugin } from '../../../../check-bundle-package-boundaries/scripts/part-side-effects.mjs';
import { barrelImportsPlugin } from '../../../../check-bundle-package-boundaries/scripts/barrel-imports.mjs';
import { partsAreToolsPlugin } from '../../scripts/parts-are-tools.mjs';
import { namedIconsPlugin } from '../../../../send-to-trillion-from-my-browser/scripts/named-icons.mjs';
import { walkthroughsPlugin } from '../../scripts/walkthroughs-plugin.mjs';
import { workspaceUtilitySource } from '../../../../screen-look/do-work/workspace-utility-source.mjs';
import { lightThemeCss } from '../../../../check-bundle-package-boundaries/scripts/light-theme.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const web = resolve(here, '../..');
const tools = resolve(here, '../../../..');
const modules = join(root, 'tools/build-engine-modules-for-web-hosts/built-stored-bytes');


const aliases = {
  name: 'standalone-workspace-aliases',
  setup(builder) {
    builder.onResolve({ filter: /^screen-arrangement-in-the-page$/ }, () => ({ path: join(modules, 'screen-arrangement/screen_arrangement.js') }));
    builder.onResolve({ filter: /^screen-arrangement-bytes$/ }, () => ({ path: join(modules, 'screen-arrangement/screen_arrangement_bg.wasm') }));
    builder.onResolve({ filter: /^composition-engine-bytes$/ }, () => ({ path: join(modules, 'composition-engine/composition_engine.wasm') }));
    builder.onResolve({ filter: /^trillion-workshop\/(.*)$/ }, args => ({ path: join(root, args.path.slice('trillion-workshop/'.length)) }));
    // The page's own `#` imports (web/package.json) for files outside web/, which esbuild resolves from their own package.
    // Files the Workshop keeps beside the page under another folder (the page's build answers them the same way).
    builder.onResolve({ filter: /(^|\/)first-answers\.json$/ }, () => ({ path: join(web, 'src/workspace/first-answers.json') }));
    builder.onResolve({ filter: /(^|\/)waiting-on-you\.json$/ }, () => ({ path: join(web, 'src/waiting-on-you.json') }));
    builder.onResolve({ filter: /^#workspace-records$/ }, () => ({ path: join(web, 'src/workspace/records.ts') }));
    builder.onResolve({ filter: /^#workspace-list-rules$/ }, () => ({ path: join(web, 'src/workspace/list-rules.ts') }));
    builder.onResolve({ filter: /^#workspace\/(.*)$/ }, args => ({ path: join(web, 'src/workspace', args.path.slice('#workspace/'.length)) }));
  },
};

// html, files and plugins let a page of its own (members-page) use this build: its shell, the files it copies beside it, and its
// own esbuild plugins. Without them the example's shell, sample lesson and plugins are used, as before.
export async function buildPage({ entry, out, html = join(here, 'index.html'), files = [[join(here, 'sample-lesson.webm'), 'sample-lesson.webm']], plugins = [] }) {
  const barrels = barrelImportsPlugin(tools);
  mkdirSync(out, { recursive: true });
  // The shipped tours, one JSON file per tour, as the page fetches them (build-workspace.mjs writes them the same way).
  const walkthroughFiles = readdirSync(join(web, 'src/workspace/walkthroughs')).filter(file => file.endsWith('.json')).sort().map(file => `src/workspace/walkthroughs/${file}`);
  writeFileSync(join(out, 'walkthroughs.json'), `[${walkthroughFiles.map(file => JSON.stringify(JSON.parse(readFileSync(join(web, file), 'utf8')))).join(',')}]`);
  const result = await build({
    absWorkingDir: here,
    entryPoints: { 'standalone-workspace': entry },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true,
    outdir: out, entryNames: '[name]', assetNames: '[name]-[hash]', metafile: true, logLevel: 'warning', legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'css', '.wasm': 'file', '.json': 'json' },
    plugins: [
      namedIconsPlugin(web, [join(web, 'src'), tools]),
      partSideEffectsPlugin(tools),
      workshopShellImportsPlugin(web, { modules: join(root, 'node_modules'), workshop: root }),
      partsAreToolsPlugin(web, tools),
      barrels.plugin,
      walkthroughsPlugin({ publicNamed: './', toursName: 'walkthroughs.json', walkthroughFiles, root: web }),
      aliases,
      ...plugins,
    ],
  });
  // The stylesheet the page draws with, assembled as the workspace build assembles its own (scripts/build-workspace.mjs):
  // the utility classes the bundled code names (Tailwind over the look's source), the looks the workspace lists, the light
  // theme's tokens, and the page's own rules.
  const look = file => readFileSync(join(tools, 'screen-look/show', file), 'utf8');
  const LOOKS = JSON.parse(readFileSync(join(web, 'scripts/workspace-looks.json'), 'utf8'));
  const tailwindSource = workspaceUtilitySource(look('coss-workspace.css'));
  const compiled = await compile(tailwindSource, { base: join(root, 'node_modules/tailwindcss'), onDependency: () => {} });
  const sources = Object.keys(result.metafile.inputs).map(input => resolve(here, input)).filter(file => file.startsWith(`${tools}/`) && /\.(m?[jt]sx?)$/.test(file));
  const candidates = new Set();
  for (const file of sources) for (const word of [...(readFileSync(file, 'utf8').match(/[^\s"'`]+/g) ?? []), ...(readFileSync(file, 'utf8').match(/[^\s"`{}]+/g) ?? [])]) candidates.add(word);
  const utilities = compiled.build([...candidates]);
  const bundledCss = existsSync(join(out, 'standalone-workspace.css')) ? readFileSync(join(out, 'standalone-workspace.css'), 'utf8') : '';
  const lightTheme = lightThemeCss(tools, [tailwindSource, utilities, ...LOOKS.map(look), ...sources.map(file => readFileSync(file, 'utf8'))]);
  const stylesheet = (await transform([utilities, look('fonts.css'), ...LOOKS.map(look), lightTheme, readFileSync(join(tools, 'ui/show/twenty/record-table.css'), 'utf8'), bundledCss].join('\n'), { loader: 'css', minify: true, logLevel: 'silent' })).code;
  writeFileSync(join(out, 'standalone-workspace.css'), stylesheet);
  copyFileSync(html, join(out, 'index.html'));
  for (const [from, to] of files) copyFileSync(from, join(out, to));
  // The faces the look names (its fonts.css and fonts/), beside the stylesheet, as the workspace build serves them.
  cpSync(join(tools, 'screen-look/show/fonts'), join(out, 'fonts'), { recursive: true });
  console.log(`built ${Object.keys(result.metafile.outputs).length} files into ${out}`);

}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPage({ entry: join(here, 'entry.ts'), out: resolve(process.argv[2] ?? join(tmpdir(), 'standalone-workspace-page')) });
}
