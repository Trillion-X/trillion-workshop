// Cross-repository integration tests read one declared immutable source through the repository reader.
// esbuild still resolves imports normally in that source's actual owner; no source is copied or redirected.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { gitReaders } from '../tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../tools/content-identity/read-data/identity.mjs';

const identity = /^1f:[0-9a-f]{64}$/;
const contained = (root, file) => file === root || file.startsWith(`${root}${sep}`);
const pathParts = value => typeof value === 'string' && value && !isAbsolute(value) && !value.includes('\\')
  && !/[\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

export function declaredTestSource(binding, manifest, { root = resolve(import.meta.dirname, '..'), repositories = {}, readers = gitReaders({ root, repositories }) } = {}) {
  if (!binding || !/^[0-9a-f]{40}$/.test(binding.commit ?? '') || !pathParts(binding.root)
      || typeof binding.repository !== 'string' || typeof binding.origin !== 'string' || !identity.test(binding.manifest_identity ?? '')) throw new Error('A test source requires its repository, origin, exact commit, subroot and BLAKE3 manifest identity.');
  if (makeHashCodeHexFromJson(manifest) !== binding.manifest_identity || manifest?.schema !== 'committed-source-manifest/v1'
      || ['repository', 'origin', 'commit', 'root'].some(key => manifest[key] !== binding[key])) throw new Error('The declared test source manifest is stale or belongs to another source.');
  const entries = Object.entries(manifest.files ?? {});
  if (!entries.length || entries.length > 20_000 || entries.some(([path, hash]) => !pathParts(path)
      || !path.startsWith(`${binding.root}/`) || !identity.test(hash))) throw new Error('Every declared source file requires an in-scope path and BLAKE3 identity.');
  const checkout = readers.checkout(binding.repository);
  if (!checkout || readers.repositoryOrigin(binding.repository) !== binding.origin
      || readers.repositoryCommit(binding.repository, binding.commit) !== binding.commit) throw new Error('The declared repository owner or exact source commit is unavailable.');
  const repositoryRoot = realpathSync(checkout), sourceRoot = realpathSync(join(repositoryRoot, binding.root));
  if (sourceRoot !== join(repositoryRoot, binding.root) || !lstatSync(sourceRoot).isDirectory()) throw new Error('The declared source subroot leaves or redirects its repository owner.');
  const observed = new Map();
  const dependencyObserved = new Map();
  const dependencyRoots = [join(sourceRoot, 'node_modules'), join(repositoryRoot, 'node_modules')];
  function sourcePath(path) {
    if (!pathParts(path)) throw new Error('A source request must be relative to its declared subroot.');
    const full = `${binding.root}/${path}`;
    if (!Object.hasOwn(manifest.files, full)) throw new Error(`The source manifest does not admit ${full}.`);
    const file = join(sourceRoot, path);
    if (realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error(`The source file is missing or redirected: ${full}.`);
    return { full, file };
  }
  function read(path) {
    const { full } = sourcePath(path);
    const bytes = readers.readSource({ repository: binding.repository, commit: binding.commit, path: full });
    if (!bytes || makeHashCodeHexFromBytes(bytes) !== manifest.files[full]) throw new Error(`The committed source identity does not match ${full}.`);
    observed.set(full, manifest.files[full]);
    return bytes;
  }
  function verifyResolution() {
    if (!Object.hasOwn(manifest.files, `${binding.root}/package.json`)) return;
    const { file } = sourcePath('package.json');
    read('package.json');
    if (makeHashCodeHexFromBytes(readFileSync(file)) !== manifest.files[`${binding.root}/package.json`]) throw new Error('The normal package resolution metadata differs from the declared source.');
  }
  const directories = new Map([['', new Map()]]);
  for (const [file] of entries) {
    const parts = file.slice(binding.root.length + 1).split('/');
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (!directories.has(parent)) directories.set(parent, new Map());
      directories.get(parent).set(parts[index], index < parts.length - 1);
    }
  }
  function classify(path) {
    const file = resolve(path instanceof URL ? fileURLToPath(path) : path);
    const dependency = dependencyRoots.some(root => contained(root, file));
    return { file, dependency, member: contained(sourceRoot, file) ? relative(sourceRoot, file).split(sep).join('/') : null };
  }
  const missing = file => Object.assign(new Error(`The declared source does not contain ${file}.`), { code: 'ENOENT' });
  // This projects the existing committed reader into the read-only methods the production build owners accept.
  // Installed dependencies keep their ordinary filesystem; they are recorded separately from committed source.
  const fs = {
    existsSync(path) {
      const { file, dependency, member } = classify(path);
      return dependency ? existsSync(file) : member !== null && (directories.has(member) || Object.hasOwn(manifest.files, `${binding.root}/${member}`));
    },
    statSync(path) {
      const { file, dependency, member } = classify(path);
      if (dependency) return statSync(file);
      if (member === null || !fs.existsSync(file)) throw missing(file);
      const directory = directories.has(member);
      return { isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
    },
    readFileSync(path, options) {
      const { file, dependency, member } = classify(path);
      let bytes;
      if (dependency) {
        bytes = readFileSync(file);
        dependencyObserved.set(relative(repositoryRoot, file).split(sep).join('/'), makeHashCodeHexFromBytes(bytes));
      } else {
        if (member === null) throw missing(file);
        bytes = read(member);
      }
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    },
    readdirSync(path, options) {
      const { file, dependency, member } = classify(path);
      if (dependency) return readdirSync(file, options);
      if (member === null || !directories.has(member)) throw missing(file);
      return [...directories.get(member)].sort(([a], [b]) => a.localeCompare(b)).map(([name, directory]) => options?.withFileTypes
        ? { name, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false } : name);
    },
  };
  function verifyModule(path, visited = new Set()) {
    const { file } = sourcePath(path);
    if (visited.has(file)) return;
    visited.add(file);
    const bytes = read(path);
    if (makeHashCodeHexFromBytes(readFileSync(file)) !== makeHashCodeHexFromBytes(bytes)) throw new Error('A production module differs from its declared committed source.');
    if (extname(path) === '.json') return;
    if (extname(path) !== '.mjs') throw new Error('A production module must be an ordinary committed .mjs entry.');
    const ast = parse(bytes.toString(), { sourceType: 'module', plugins: ['importAttributes'] });
    function inspect(node) {
      if (!node || typeof node !== 'object') return;
      const imported = ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) ? node.source?.value : null;
      if (imported && !imported.startsWith('node:')) {
        if (!imported.startsWith('.')) throw new Error('A production module dependency needs a declared local source or Node built-in.');
        const target = relative(sourceRoot, resolve(dirname(file), imported)).split(sep).join('/');
        verifyModule(target, visited);
      }
      if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee?.type === 'Import')) throw new Error('Dynamic production imports require their own declared source binding.');
      for (const [key, value] of Object.entries(node)) {
        if (['start', 'end', 'loc'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(inspect);
        else if (value && typeof value === 'object') inspect(value);
      }
    }
    inspect(ast);
  }
  return {
    root: sourceRoot,
    read,
    fs,
    module: async path => {
      verifyResolution(); verifyModule(path);
      const loaded = await import(pathToFileURL(sourcePath(path).file).href);
      verifyModule(path);
      return loaded;
    },
    json: path => JSON.parse(read(path)),
    path: path => { read(path); return sourcePath(path).file; },
    proof: () => ({ repository: binding.repository, origin: binding.origin, commit: binding.commit, root: binding.root,
      manifest_identity: binding.manifest_identity, files: [...observed].sort(([a], [b]) => a.localeCompare(b)),
      dependency_files: [...dependencyObserved].sort(([a], [b]) => a.localeCompare(b)) }),
    plugin: () => ({
      name: 'declared-committed-test-source',
      setup(build) {
        verifyResolution();
        build.onEnd(() => { verifyResolution(); });
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
          const file = resolve(args.path);
          const dependency = dependencyRoots.some(root => contained(root, file));
          if (dependency) return undefined; // Installed dependencies retain normal resolution and their real errors.
          if (!contained(sourceRoot, file)) throw new Error('A bundle input leaves the declared source and its installed dependency owner.');
          const bytes = read(relative(sourceRoot, file).split(sep).join('/'));
          const suffix = extname(file);
          const loader = build.initialOptions.loader?.[suffix] ?? ({ '.mjs': 'js', '.cjs': 'js', '.js': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'css' })[suffix];
          if (!loader) throw new Error(`The test source has no declared loader for ${suffix}.`);
          return { contents: bytes, loader, resolveDir: dirname(file) };
        });
      },
    }),
  };
}
