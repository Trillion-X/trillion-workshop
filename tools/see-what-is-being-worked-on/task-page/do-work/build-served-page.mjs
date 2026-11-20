// tools/see-what-is-being-worked-on/task-page/do-work/build-served-page.mjs
//
// Builds the page folder tool:serve-the-task-pages declares (invoke.pages): pages/index.html (the Workshop's page shell in
// the workspace look, with the island show/served-page.tsx), pages/callback.html (where the sign-in returns), pages/page.js
// (the island, bundled) and pages/page.css (the page's utility classes and the shell's own styles). The door serves these
// under a policy that allows no inline style or script, so the shell's <style> is moved into page.css. Built with the
// Workshop's own esbuild and Tailwind (compiled as tools/workspace-screens/web/scripts/build-workspace.mjs does); run again
// after a change to the page's show files, and commit the folder.
//
//   node tools/see-what-is-being-worked-on/task-page/do-work/build-served-page.mjs
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '..');
const ROOT = resolve(PAGE, '../../..');
const OUT = join(PAGE, 'pages');
const TITLE = 'Work, as it stands';

mkdirSync(OUT, { recursive: true });
await build({ entryPoints: [join(PAGE, 'show/served-page.tsx')], bundle: true, minify: true, format: 'iife', outfile: join(OUT, 'page.js'),
  alias: { 'trillion-workshop': ROOT }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });

// The shell, made by the Workshop's own server-rendered page owner, read by a bundle of its own so its imports resolve here.
const scratch = mkdtempSync(join(tmpdir(), 'served-page-'));
await build({ stdin: { contents: `export { pageShellHtml, PAGE_SECTIONS_CSS } from 'trillion-workshop/tools/ui/show/server-rendered-page/page-sections-html.mjs';
export { PAGE_LOOK } from 'trillion-workshop/tools/workspace-screens/web/src/page-look.mjs';`, resolveDir: ROOT },
  bundle: true, platform: 'node', format: 'esm', outfile: join(scratch, 'shell.mjs'), alias: { 'trillion-workshop': ROOT }, logLevel: 'warning' });
const { pageShellHtml, PAGE_SECTIONS_CSS, PAGE_LOOK } = await import(join(scratch, 'shell.mjs'));
const shell = pageShellHtml({ title: TITLE, look: PAGE_LOOK, island: { bundle_url: 'page.js', stylesheet_url: 'page.css', mount_element_id: 'timeline',
  inline_css: `${PAGE_SECTIONS_CSS}#timeline.page-view{margin:0}` } });
const styles = [...shell.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
const html = shell.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<link rel="stylesheet" href="\/workspace\/fonts\.css"\/>/, '');
writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(join(OUT, 'callback.html'), html.replace(`<title>${TITLE}</title>`, '<title>Signing in</title>'));

// The utility classes the page's show files use (every word of their source is a candidate, as the workspace build reads
// them), then the shell's own styles and the shared marks.
const folders = ['tools/see-what-is-being-worked-on/task-page/show', 'tools/show-any-file-as-itself/show', 'tools/ui/show/segmented-control', 'tools/ui/show/badge', 'tools/ui/show/line-chart'];
const sources = [...folders.flatMap(folder => readdirSync(join(ROOT, folder)).filter(file => /\.(m?[jt]sx?)$/.test(file)).map(file => join(ROOT, folder, file))), join(ROOT, 'tools/ui/show/glass-tokens.ts')];
const words = new Set(sources.flatMap(file => { const text = readFileSync(file, 'utf8'); return [...(text.match(/[^\s"'`]+/g) ?? []), ...(text.match(/[^\s"`{}]+/g) ?? [])]; }));
const compiled = await compile('@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n', { base: join(ROOT, 'node_modules/tailwindcss'), onDependency: () => {} });
const utilities = compiled.build([...words]);
const marks = ['tools/screen-look/show/step-mark.css', 'tools/screen-look/show/nested-corners.css'].map(file => readFileSync(join(ROOT, file), 'utf8'));
writeFileSync(join(OUT, 'page.css'), [styles, utilities, ...marks].join('\n'));
console.log(`built ${OUT}`);
