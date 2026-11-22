// How a file inside this repository reaches `trillion-workshop/...` when its nearest package.json is not the root's.
//
// Purpose
//   A tool folder with its own package.json (tools/organize-the-sidebar, tools/run-on-a-persons-computer,
//   tools/workspace-screens/web) hides the root package.json, so the root's `exports` cannot serve a self-reference from
//   its files. Installed under node_modules/trillion-workshop the package name is found by the ordinary walk up, but in a
//   checkout or an export nothing is, and the lock file may hold no link to the Workshop itself: the Mac's engine refuses
//   a lock entry with `link: true` (test/lockfile-has-no-link.test.mjs). This Node module customization hook
//   (https://nodejs.org/api/module.html#customization-hooks) answers `trillion-workshop/<path>` with the same path under
//   this repository's root, as the link did.
//
// Use
//   Imported by test-helpers/own-tmpdir.mjs, which `npm test` preloads with --import. It registers this file once, and
//   puts the same --import in NODE_OPTIONS so a node process a test starts asks the same way.
//
// Non-negotiable invariants
//   1. Only a specifier of the form `trillion-workshop/<path>` is answered; every other specifier goes to Node untouched.
//   2. The answer is a path inside this root: the hook stays a name for the root and gives no way out of it.
import { register, registerHooks } from 'node:module';
import { dirname, join, relative, resolve as absolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';

const PACKAGE = 'trillion-workshop';
const root = absolute(dirname(fileURLToPath(import.meta.url)), '..');

/** The file URL of `trillion-workshop/<path>` inside this root, or undefined when `specifier` is not of that form. */
export function inThisWorkshop(specifier) {
  if (!specifier.startsWith(`${PACKAGE}/`)) return undefined;
  const asked = absolute(root, specifier.slice(PACKAGE.length + 1));
  const inside = relative(root, asked);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) return undefined;
  return pathToFileURL(join(root, inside)).href;
}

export function resolve(specifier, context, nextResolve) {
  const asked = inThisWorkshop(specifier);
  return nextResolve(asked ?? specifier, context);
}

// registerHooks runs the hooks in this thread. register() runs them on a worker thread that the main thread waits on, and that wait
// deadlocked a gateway build, so register() is only the fallback for a Node without registerHooks (before 22.15).
// The fallback's hooks run in their own thread, which loads this file again; only the thread that asked registers.
if (isMainThread) {
  if (typeof registerHooks === 'function') registerHooks({ resolve });
  else register(import.meta.url);
  const preload = `--import ${pathToFileURL(fileURLToPath(import.meta.url)).href}`;
  if (!(process.env.NODE_OPTIONS ?? '').includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}
