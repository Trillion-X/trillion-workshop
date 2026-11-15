import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { byteIdentity } from './byte-identity-for-tests.mjs';

const selected = process.env.TRILLION_WORKSHOP_SOURCE;
const sourcePaths = [
  'tools/headless-browser/launch.mjs',
  'tools/headless-browser/admission.mjs',
  'tools/headless-browser/quiet-switches.json',
  'tools/process-session/do-work/process-admission.mjs',
  'tools/process-session/do-work/place-cache-folder.mjs',
  'tools/screen-look/show/surfaces.css',
  'tools/screen-look/show/media-loading.css',
  'tools/screen-look/show/loading-mark.css',
  'tools/keep-lists-of-rows/read-data/row-record-address.mjs',
  'tools/keep-lists-of-rows/read-data/list-title-projection.mjs',
  'tools/http-client/do-work/same-origin.mjs',
];
const publicScreenLookFiles = new Set(['surfaces.css', 'media-loading.css', 'loading-mark.css']);
const selectedSourceModules = new Set([
  'trillion-workshop/tools/keep-lists-of-rows/read-data/row-record-address.mjs',
  'trillion-workshop/tools/keep-lists-of-rows/read-data/list-title-projection.mjs',
  'trillion-workshop/tools/http-client/do-work/same-origin.mjs',
]);
let launcher;
let workshopRoot;
if (selected) {
  workshopRoot = realpathSync(resolve(selected));
  const exactPaths = sourcePaths.map(path => {
    const absolute = realpathSync(join(workshopRoot, path));
    if (!absolute.startsWith(`${workshopRoot}${sep}`)) throw new Error(`Workshop helper escaped the selected source root: ${path}`);
    return absolute;
  });
  const version = execFileSync('git', ['-C', workshopRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const identities = exactPaths.map((absolute, index) => {
    const digest = byteIdentity(readFileSync(absolute));
    const gitObject = execFileSync('git', ['-C', workshopRoot, 'hash-object', '--', sourcePaths[index]], { encoding: 'utf8' }).trim();
    return `${sourcePaths[index]}=blake3:${digest},git-blob:${gitObject}`;
  });
  console.info(`[Workshop browser source] selected checkout ${workshopRoot} @ ${version}; ${identities.join('; ')}`);
  // This imports only the selected checkout's real, admitted Chromium launcher.
  launcher = await import(pathToFileURL(exactPaths[0]).href);
} else {
  // Normal tests exercise the installed public package and expose its genuine import/runtime errors.
  launcher = await import('trillion-workshop/tools/headless-browser/launch.mjs');
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('trillion-workshop/package.json');
  const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8'));
  workshopRoot = dirname(packagePath);
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', pathToFileURL(`${process.cwd()}/`)), 'utf8'));
  const lockedPackage = lock.packages?.['node_modules/trillion-workshop'];
  console.info(`[Workshop browser source] installed ${packageInfo.name} at ${packagePath}; lock ${lockedPackage?.resolved ?? 'unrecorded'}; launcher ${import.meta.resolve('trillion-workshop/tools/headless-browser/launch.mjs')}`);
}
export const launchChromium = launcher.launchChromium;
export const launchPersistentChromium = launcher.launchPersistentChromium;

export function workshopScreenLookCss(name) {
  if (!publicScreenLookFiles.has(name)) throw new Error(`Workshop screen-look asset is not allowlisted: ${name}`);
  return join(workshopRoot, 'tools', 'screen-look', 'show', name);
}

export function workshopSelectedModulesPlugin(requested) {
  const allowed = new Set(requested);
  for (const specifier of allowed) {
    if (!selectedSourceModules.has(specifier)) throw new Error(`Workshop source module is not allowlisted: ${specifier}`);
  }
  return {
    name: 'explicit-workshop-source-modules',
    setup(build) {
      build.onResolve({ filter: /^trillion-workshop\/tools\// }, args => {
        if (!selected || !allowed.has(args.path)) return undefined;
        const sourcePath = realpathSync(join(workshopRoot, args.path.slice('trillion-workshop/'.length)));
        if (!sourcePath.startsWith(`${workshopRoot}${sep}`)) throw new Error(`Workshop source module escaped the selected root: ${args.path}`);
        return { path: sourcePath };
      });
    },
  };
}
