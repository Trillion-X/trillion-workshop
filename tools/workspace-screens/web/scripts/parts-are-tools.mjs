// A screen file written when the web client kept its parts in its own parts folder asks for a part by the relative path it was
// written with, or by the `@/packages/` name the client's compiler gave that folder. The Workshop keeps each part as the tool of
// the same name, so such an import names a file of the tool with that name: this plugin answers it with that file.
//   1. A relative import that lands in a `web/parts/` folder (this client's, or the one a tool carries beside its own web
//      files) is answered with the file of that name under the Workshop's tools folder.
//   2. `@/packages/<part>/...` is answered the same way.
//   3. A relative import written from a part's folder that climbs out of tools/ to a file of the web client (its src, assets or
//      records folder, which sat above the parts) is answered with that file of this client.
//   4. parts-are-tools.json names the parts the Workshop calls by another name, and the client files it keeps in a tool.
// An import it cannot find is left to esbuild, which fails the build and names it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const WEB = `${sep}web${sep}`;
const WEB_PARTS = `${sep}web${sep}parts${sep}`;

/** Where the client's file `file` (a path in the web client's folder) is read from: its tool's file when parts-are-tools.json names one. */
export function clientFileAt(root, file, data = JSON.parse(readFileSync(new URL('./parts-are-tools.json', import.meta.url), 'utf8'))) {
  return data.files[file] ? join(dirname(dirname(dirname(root))), data.files[file]) : join(root, file);
}

/** The file of the Workshop tool that a path under the client's old `parts/` folder names (`asked`, absolute), or undefined. */
export function toolFileOfPart(asked, tools, data = JSON.parse(readFileSync(new URL('./parts-are-tools.json', import.meta.url), 'utf8'))) {
  const part = asked.indexOf(WEB_PARTS);
  if (part < 0) return undefined;
  const [name, ...more] = asked.slice(part + WEB_PARTS.length).split(sep);
  const path = join(tools, data.renamed_tools[name] ?? name, ...more);
  return EXTENSIONS.map(extension => path + extension).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
}

/** esbuild plugin: `root` is the web client's folder, `tools` the Workshop's tools folder. */
export function partsAreToolsPlugin(root, tools, data = JSON.parse(readFileSync(new URL('./parts-are-tools.json', import.meta.url), 'utf8'))) {
  const workshop = dirname(tools);
  const fileAt = path => EXTENSIONS.map(extension => path + extension).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  const inside = (folder, path) => path === folder || path.startsWith(folder + sep);
  const ofPart = rest => {
    const [part, ...more] = rest.split('/');
    return join(tools, data.renamed_tools[part] ?? part, ...more);
  };
  return {
    name: 'parts-are-tools',
    setup(build) {
      for (const [name, file] of Object.entries(data.client_names)) build.onResolve({ filter: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ path: join(root, file) }));
      build.onResolve({ filter: /^@\/packages\// }, args => {
        const found = fileAt(ofPart(args.path.slice('@/packages/'.length)));
        return found ? { path: found } : undefined;
      });
      build.onResolve({ filter: /^\.\.?\// }, args => {
        if (!args.importer) return undefined;
        const asked = resolve(args.resolveDir, args.path);
        if (asked.includes(WEB_PARTS)) {
          const found = toolFileOfPart(asked, tools, data);
          return found ? { path: found } : undefined;
        }
        const web = asked.lastIndexOf(WEB);
        const kept = web >= 0 && data.files[asked.slice(web + WEB.length).split(sep).join('/')];
        if (kept) return { path: join(workshop, kept) };
        if (inside(tools, args.resolveDir) && !inside(tools, asked) && inside(workshop, asked)) {
          const found = fileAt(join(root, relative(workshop, asked)));
          return found ? { path: found } : undefined;
        }
        return undefined;
      });
    },
  };
}
