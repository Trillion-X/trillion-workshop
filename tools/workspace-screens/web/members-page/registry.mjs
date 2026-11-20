// tools/workspace-screens/web/members-page/registry.mjs
//
// PURPOSE
//   Finds the screen modules of a set of packages for the members page build (build.mjs). Node only: the page never runs it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A screen module is a `*-screen-mount.tsx` file under a package's web/ folder (rows.mjs SCREEN_FILE).
//   2. Two modules with one key are refused, so a key always means one file.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCREEN_FILE, screenKeyOf } from './rows.mjs';

/** Every screen module under one package's web/ folder: { key, path }. */
export function screenModulesIn(toolsRoot, packageName) {
  const found = [];
  const walk = folder => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SCREEN_FILE.test(name)) found.push({ key: screenKeyOf(packageName, path), path });
    }
  };
  walk(join(toolsRoot, packageName, 'web'));
  return found;
}

/** Every screen module of the packages, once each; a key two files share is an error. */
export function screenModulesOf(toolsRoot, packages) {
  const modules = new Map();
  for (const packageName of packages) {
    for (const module of screenModulesIn(toolsRoot, packageName)) {
      if (modules.has(module.key)) throw new Error(`two screen modules share the key ${module.key}: ${modules.get(module.key)} and ${module.path}`);
      modules.set(module.key, module.path);
    }
  }
  return [...modules].map(([key, path]) => ({ key, path }));
}

