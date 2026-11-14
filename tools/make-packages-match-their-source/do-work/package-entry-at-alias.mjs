import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

// A package-set import wins when it exists. A vendored source tree may then use
// its own @/lib or @/hooks imports without imposing those names on every app.
export function createPackageEntryAtAliasPlugin({ packageSetRoot }) {
  const root = realpathSync(packageSetRoot);
  return {
    name: 'package-entry-scoped-at-alias',
    setup(build) {
      build.onResolve({ filter: /^@\// }, async (args) => {
        const suffix = args.path.slice(2);
        if (!suffix || suffix.includes('\\') || suffix.split('/').some(part => !part || part === '.' || part === '..')) {
          return { errors: [{ text: `Invalid @ import: ${args.path}` }] };
        }
        const candidates = [path.join(root, suffix)];
        const importer = args.importer && path.resolve(args.importer);
        if (importer && inside(root, importer)) {
          for (let directory = path.dirname(importer); inside(root, directory) && directory !== root; directory = path.dirname(directory)) {
            if (path.basename(directory) === 'source') candidates.push(path.join(directory, suffix));
          }
        }
        for (const candidate of candidates) {
          if (!inside(root, candidate)) continue;
          const resolved = await build.resolve(candidate, { kind: args.kind, resolveDir: args.resolveDir });
          if (resolved.errors.length || !resolved.path || !existsSync(resolved.path)) continue;
          const real = realpathSync(resolved.path);
          if (!inside(root, real) || !lstatSync(real).isFile()) {
            return { errors: [{ text: `@ import escaped the selected package set: ${args.path}` }] };
          }
          return { path: real, namespace: resolved.namespace, sideEffects: resolved.sideEffects };
        }
        return { errors: [{ text: `No package-set or source-local file resolves ${args.path} from ${args.importer}` }] };
      });
    },
  };
}
