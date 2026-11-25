// scripts/named-icons.mjs
//
// Purpose: the icons a browser bundle carries are the icons Trillion's own DATA and code name, found when the bundle is
// built. An icon travels as a name ("Trash2", "trash-2", or `icon: "folder"`) in records, screen rows, field
// descriptors and components, and the shared resolver (tools/ui/show/icon/NamedIcon.tsx) turns it into a Lucide
// component through `./named-icons`. On disk that module is all of Lucide, so any caller that has not been built
// (a node test, a script) still resolves every name; a browser bundle replaces it with only the names found here.
//
// Non-negotiable invariants:
// - No icon is listed by hand: a name enters the bundle because a file under the scanned folders names it.
// - A name is an icon only when Lucide exports a component by it (registry casing, or kebab-case turned into it).
//   A bare lowercase word counts only as the value of an icon field (`icon`, `screen_icon`, `emptyIcon`...), since
//   ordinary words ("table", "search") are everywhere else.
// - A name nothing in the repository mentions (a person's own record naming an icon no file names) resolves to the
//   resolver's fallback, never to an error.
// - With a split, an icon not in the first file is drawn as the fallback only until the rest arrive, then as itself.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const SKIPPED = new Set(['node_modules', 'built-stored-bytes', 'dist', 'target']);
const TEXT = /\.(json|m?[jt]sx?)$/;

// Lucide's icon components by name (aliases included), without its helpers, from the lucide-react installed beside
// the build's node_modules (the Workshop holds no package of its own for the shared parts; the build says where they are).
const iconNamesOf = new Map();
const ICON_NAMES = root => {
  if (!iconNamesOf.has(root)) {
    const lucide = createRequire(join(root, 'package.json'))('lucide-react');
    iconNamesOf.set(root, new Set(Object.entries(lucide)
      .filter(([name, value]) => /^[A-Z]/.test(name) && !name.startsWith('Lucide') && !name.endsWith('Icon') && name !== 'Icon'
        && (typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value)))
      .map(([name]) => name)));
  }
  return iconNamesOf.get(root);
};

const pascal = name => name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

function* textFiles(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* textFiles(path);
    else if (TEXT.test(entry.name)) yield path;
  }
}

/** Every Lucide icon name the files under the given folders mention, sorted (read once per root and folders per process). */
const scanned = new Map();
export function usedIconNames(root, folders) {
  const key = [root, ...folders].join('\n');
  if (!scanned.has(key)) scanned.set(key, namesIn(root, folders.flatMap(folder => [...textFiles(folder)])));
  return scanned.get(key);
}

/** Every Lucide icon name the given files mention, sorted. */
function namesIn(root, files) {
  const found = new Set();
  const keep = candidate => { if (ICON_NAMES(root).has(candidate)) found.add(candidate); };
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(/["'`]([A-Z][A-Za-z0-9]*)["'`]/g)) keep(name);
    for (const [, name] of text.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["'`]/g)) keep(pascal(name));
    for (const [, name] of text.matchAll(/[A-Za-z_]*[iI]con["']?\s*[:=]\s*\{?\s*["'`]([a-z][a-z0-9]*)["'`]/g)) keep(pascal(name));
  }
  return [...found].sort();
}

/** The esbuild plugin that gives NamedIcon.tsx's `./named-icons` only the icons the repository names. With `split`
 *  ({ files() }), the module carries at once only the icons the files `split.files()` names mention (the page's first
 *  load: its sidebar, its screen rows, its own code), and the rest arrive in one file of their own when an icon not
 *  among them is first drawn (`rest()`); until `split.files()` answers, every icon comes at once. */
// The folder of an installed package as the build reaches it: the first node_modules/<name> above `root`, by that path and
// never the target of a linked node_modules. Node's own lookup (require.resolve) answers the link's target, a folder of the
// computer that ran the build, and that path then decided which React the icons import and went into every bundle's content
// name (Nov 25 2026: each apply renamed the gateway's page bundles).
export function installedFolder(root, name) {
  for (let at = resolve(root); ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules', name, 'package.json'))) return join(at, 'node_modules', name);
    if (dirname(at) === at) throw new Error(`${name} is not installed above ${root}`);
  }
}

export function namedIconsPlugin(root, folders, split = null) {
  // Each icon from its own file, never through Lucide's index: a bundle that splits code places every icon a later file
  // uses in the first load when the first load imports the index (2026-10-05: 483 icons, 116 kB).
  let files = null;
  const fileOf = name => {
    if (!files) {
      const lucide = installedFolder(root, 'lucide-react');
      const index = join(lucide, JSON.parse(readFileSync(join(lucide, 'package.json'), 'utf8')).module);
      files = new Map();
      for (const [, names, from] of readFileSync(index, 'utf8').matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        for (const one of names.split(',')) { const given = one.trim().split(/\s+as\s+/).pop(); if (given) files.set(given, resolve(dirname(index), from)); }
      }
    }
    return files.get(name);
  };
  const icons = names => {
    const placed = names.filter(name => fileOf(name));
    return `${placed.map(name => `import ${name} from ${JSON.stringify(fileOf(name))};`).join('\n')}\nexport default { ${placed.join(', ')} };\n`;
  };
  return {
    name: 'named-icons',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/named-icons$/ }, args => (args.importer.endsWith(join('icon', 'NamedIcon.tsx')) ? { path: 'named-icons', namespace: 'named-icons' } : undefined));
      builder.onResolve({ filter: /^named-icons-rest$/ }, args => (args.namespace === 'named-icons' ? { path: 'rest', namespace: 'named-icons' } : undefined));
      builder.onLoad({ filter: /.*/, namespace: 'named-icons' }, args => {
        const all = usedIconNames(root, folders);
        const files = split?.files() ?? null;
        const first = files ? new Set(namesIn(root, files)) : null;
        if (args.path === 'rest') return { contents: icons(all.filter(name => !first?.has(name))), loader: 'js', resolveDir: root };
        if (!first) return { contents: `${icons(all)}export const rest = async () => ({});\n`, loader: 'js', resolveDir: root };
        return { contents: `${icons(all.filter(name => first.has(name)))}export const rest = () => import('named-icons-rest').then(module => module.default);\n`, loader: 'js', resolveDir: root };
      });
    },
  };
}
