// A Workshop tool the page bundles may still import a file that stayed with the web shell when old trillion's features
// moved to trillion-workshop (Trillion-X/trillion 7fd8838475): the ui part (old parts/ui, now web/parts/ui) or a src
// file that sat beside a moved src file (now web/src), or a part's file that stayed in its part when a sibling moved
// into a differently named tool (one web/parts/<part>/<folder>/<file> of that folder and name). Such an import names a path inside the Workshop package that the
// package does not hold; this plugin answers it with the web shell's file. An import the Workshop does hold is left to
// esbuild, and one neither holds still fails the build. A moved file's import of one of the page's own import names
// (package.json `imports`) is answered the same way. A Workshop module the web shell holds a newer copy of
// (workshop-shell-homes.json `shell`) is answered with the web shell's copy, from the page and from the Workshop alike;
// a Workshop import of a path that moved inside the Workshop (`home`) is answered with where it lives now.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const disk = { existsSync, readdirSync, readFileSync, statSync };

const localPath = value => typeof value === 'string' && value.length > 0 && !/[\\\u0000-\u001f\u007f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Active owners stay inside their canonical root and never read held historical snapshots. */
export function confinedOwnerPath(root, target, description) {
  const refuseHeld = path => {
    if (path.endsWith('.held')) throw new Error(`${path} is a held historical snapshot, not an active owner`);
  };
  refuseHeld(target);
  if (existsSync(target)) {
    const canonical = realpathSync(target);
    refuseHeld(canonical);
    const inside = relative(realpathSync(root), canonical);
    if (inside === '..' || inside.startsWith(`..${sep}`) || inside.startsWith(sep)) throw new Error(description);
  }
  return target;
}

/** The declared homes for bundling, read from this build/export. */
export function workshopShellHomes(root, { fs = disk, modules = join(root, 'node_modules') } = {}) {
  const rows = JSON.parse(fs.readFileSync(join(root, 'scripts/workshop-shell-homes.json'), 'utf8')).rows;
  if (!Array.isArray(rows)) throw new Error('Workshop shell homes need rows.');
  const homes = new Map();
  for (const row of rows) {
    if (!localPath(row.workshop) || !row.workshop.startsWith('tools/') || Boolean(row.shell) === Boolean(row.home)
      || !localPath(row.shell ?? row.home) || (row.shell && row.shell.split('/').includes('node_modules'))
      || typeof row.why !== 'string' || !row.why.trim()) throw new Error('A Workshop shell home needs confined paths, one shell or home, and its reason.');
    const asked = join(modules, 'trillion-workshop', row.workshop);
    if (homes.has(asked)) throw new Error(`Workshop shell home repeated: ${row.workshop}`);
    const ownerRoot = row.shell ? root : join(modules, 'trillion-workshop');
    const target = confinedOwnerPath(ownerRoot, join(ownerRoot, row.shell ?? row.home), row.shell
      ? `Workshop shell home leaves the source tree: ${row.shell}`
      : `Workshop home leaves the Workshop package: ${row.home}`);
    homes.set(asked, target);
  }
  return homes;
}

// A declared source integration supplies the same read-only methods; ordinary builds keep the native filesystem.
export function workshopShellImportsPlugin(root, { fs = disk, modules = join(root, 'node_modules') } = {}) {
  const { existsSync, readdirSync, readFileSync, statSync } = fs;
  const fileAt = path => EXTENSIONS.map(ext => path + ext).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  const tools = join(modules, 'trillion-workshop', 'tools');
  const packageRoot = join(modules, 'trillion-workshop');
  // Transitional build compatibility while the native carried copies are removed before the web features move.
  // The runtime path declaration is the one map of those former app paths to their Workshop owner. A surviving
  // local file always wins; only a missing mapped path may be answered by the existing build package. Step 4 removes
  // this build-time feature integration along with the Workshop package dependency.
  const runtimePathsFile = join(root, '../computer/workshop-paths.json');
  const runtimePaths = existsSync(runtimePathsFile)
    ? JSON.parse(readFileSync(runtimePathsFile, 'utf8')).paths : {};
  if (!runtimePaths || Array.isArray(runtimePaths) || typeof runtimePaths !== 'object') throw new Error('Workshop runtime paths need a path map.');
  for (const [former, owner] of Object.entries(runtimePaths)) {
    if (!localPath(former) || !localPath(owner) || !owner.startsWith('tools/')) throw new Error('Workshop runtime paths need confined source and owner paths.');
  }
  const removedAppHome = asked => {
    if (fileAt(asked)) return undefined;
    const former = relative(root, asked).split(sep).join('/');
    const fromApp = relative(dirname(root), asked).split(sep).join('/');
    const owner = EXTENSIONS.map(extension => runtimePaths[former + extension] ?? runtimePaths[fromApp + extension]).find(Boolean);
    if (!owner) return undefined;
    const target = confinedOwnerPath(packageRoot, join(packageRoot, owner), `Workshop runtime owner leaves its package: ${owner}`);
    return fileAt(target);
  };
  const canonicalTools = existsSync(packageRoot) ? join(realpathSync(packageRoot), 'tools') : tools;
  const logicalImporter = importer => importer.startsWith(tools + sep) ? importer
    : importer.startsWith(canonicalTools + sep) ? join(tools, relative(canonicalTools, importer)) : null;
  // The page's own import names (package.json `imports`, e.g. #workspace/*), which a moved file still asks by name.
  const imports = Object.entries(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).imports ?? {});
  const named = asked => {
    for (const [name, target] of imports) {
      if (name === asked) return resolve(root, target);
      if (name.endsWith('*') && asked.startsWith(name.slice(0, -1))) return resolve(root, target.replace('*', asked.slice(name.length - 1)));
    }
    return undefined;
  };
  const stayedInPart = inTools => {
    const [, folder, ...rest] = inTools.split(sep);
    if (!folder || rest.length !== 1) return undefined;
    const found = readdirSync(join(root, 'parts')).map(part => fileAt(join(root, 'parts', part, folder, rest[0]))).filter(Boolean);
    return found.length === 1 ? found[0] : undefined;
  };
  // A file moved into a tool under its source path (the tool's moved-from.json names it) still asks, by the relative
  // paths it was written with, for the files that stayed in the web shell: the same path from the repository root.
  const movedFiles = new Map();
  const movedIn = tool => {
    if (!movedFiles.has(tool)) {
      const receipt = join(tools, tool, 'moved-from.json');
      movedFiles.set(tool, new Set(existsSync(receipt) ? (JSON.parse(readFileSync(receipt, 'utf8')).files ?? []).map(file => file.to) : []));
    }
    return movedFiles.get(tool);
  };
  const stayedWhereItMoved = (importer, inTools) => {
    const [tool, ...rest] = relative(tools, importer).split(sep);
    if (!tool || !rest.length || !movedIn(tool).has(`tools/${tool}/${rest.join('/')}`)) return undefined;
    return fileAt(join(dirname(root), ...inTools.split(sep).slice(1)));
  };
  const homes = workshopShellHomes(root, { fs, modules });
  return {
    name: 'workshop-shell-imports',
    setup(build) {
      build.onResolve({ filter: /^trillion-workshop\// }, args => {
        const shell = homes.get(join(modules, args.path));
        return shell ? { path: shell } : undefined;
      });
      build.onResolve({ filter: /^#/ }, args => {
        if (!logicalImporter(args.importer)) return undefined;
        const path = named(args.path);
        const home = path && (fileAt(path) ?? removedAppHome(path));
        return home ? { path: home } : undefined;
      });
      build.onResolve({ filter: /^\.\.?\// }, args => {
        const importer = logicalImporter(args.importer);
        if (!importer) {
          if (!args.importer) return undefined;
          const home = removedAppHome(resolve(dirname(args.importer), args.path));
          return home ? { path: home } : undefined;
        }
        const asked = resolve(dirname(importer), args.path);
        const home = homes.get(fileAt(asked) ?? asked);
        if (home) return { path: home };
        if (fileAt(asked)) return undefined;
        const inTools = relative(tools, asked);
        if (inTools.startsWith('..')) return undefined;
        const stayed = stayedWhereItMoved(importer, inTools);
        if (stayed) return { path: stayed };
        const shell = fileAt(join(root, 'parts', inTools)) ?? removedAppHome(join(root, 'parts', inTools))
          ?? fileAt(join(root, 'src', basename(inTools))) ?? removedAppHome(join(root, 'src', basename(inTools))) ?? stayedInPart(inTools);
        return shell ? { path: shell } : undefined;
      });
    },
  };
}
