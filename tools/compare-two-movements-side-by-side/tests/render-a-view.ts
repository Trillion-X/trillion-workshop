// tools/compare-two-movements-side-by-side/tests/render-a-view.ts
//
// Draws one screen file's `View` to static markup the way the site tool does on the server: the file and what it imports are
// bundled for node with esbuild (the same loader table the screen-entries build test uses), and the bundle is run once. Nothing
// is written to disk and no browser is used. The entry is named by absolute path; props are plain JSON.
import { createRequire } from 'node:module';
import { build } from 'esbuild';

export async function renderAView(entry: string, props: unknown): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { View } from ${JSON.stringify(entry)};
export const html = props => renderToStaticMarkup(createElement(View, props));`,
      resolveDir: import.meta.dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // A CSS module draws as its own class names (each key answers itself), so a screen's markup shows which classes it asks for.
    plugins: [{ name: 'css-module-names', setup: b => b.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: 'export default new Proxy({}, { get: (_, key) => String(key) });', loader: 'js' })) }],
    logLevel: 'silent',
    loader: { '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'empty' },
  });
  const code = result.outputFiles[0].text;
  const module: { exports: { html?: (props: unknown) => string } } = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, createRequire(import.meta.url));
  return module.exports.html!(props);
}
