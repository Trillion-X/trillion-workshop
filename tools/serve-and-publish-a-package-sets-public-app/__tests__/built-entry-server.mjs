// Test-only compilation of the generic server. The file is passed directly to this test process
// and removed on exit. Tests never discover package-set deployment output.

import esbuild from 'esbuild';
import { existsSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES_ROOT = resolve(PACKAGE_ROOT, '../..');
export const PACKAGE_SETS_DIR = join(homedir(), '.bitfield', 'runtime-kit', 'package-sets');
export const ENTRY_SERVER_SOURCE = join(PACKAGE_ROOT, 'processes', 'public-entry-server-source.mjs');

const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json', '/index.ts', '/index.tsx', '/index.js'];
function resolveUnder(base) {
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

let buildPromise;
let cleanupRoot;

async function buildGenericServerForThisTestProcess() {
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'hosted-public-app-test-'));
    const server = join(cleanupRoot, 'public-entry-server.cjs');
    const reactDir = join(PACKAGES_ROOT, 'node_modules/react');
    const reactDomDir = join(PACKAGES_ROOT, 'node_modules/react-dom');
    const aliasPlugin = {
      name: 'bitfield-test-alias',
      setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => {
          const found = resolveUnder(join(PACKAGES_ROOT, args.path.slice(2)));
          return found ? { path: found } : undefined;
        });
        build.onResolve({ filter: /^@bitfield-package-entry-scope\// }, (args) => {
          const found = resolveUnder(join(PACKAGES_ROOT, 'packages', args.path.replace('@bitfield-package-entry-scope/', '')));
          return found ? { path: found } : undefined;
        });
      },
    };
    await esbuild.build({
      absWorkingDir: PACKAGES_ROOT,
      entryPoints: [ENTRY_SERVER_SOURCE],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: server,
      jsx: 'automatic',
      plugins: [aliasPlugin],
      alias: { react: reactDir, 'react-dom': reactDomDir },
      legalComments: 'none',
      logLevel: 'silent',
    });
    return server;
  })();
  return buildPromise;
}

process.once('exit', () => {
  if (cleanupRoot) rmSync(cleanupRoot, { recursive: true, force: true });
});

export async function theBuiltEntryServer() {
  const server = await buildGenericServerForThisTestProcess();
  return {
    server,
    note: `server under test: ${server}`,
  };
}
