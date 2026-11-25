// scripts/workspace-screen-sizes.mjs
//
// Purpose: read what the signed-in workspace costs from its own build (scripts/build-workspace.mjs writes the bundle's
// import graph to workspace.meta.json): the script every screen pays before it runs, and what each screen adds when it
// first opens (its own file and the shared files it needs that the first load did not bring).
//
// Non-negotiable invariants:
// - Sizes are the bytes esbuild wrote, never estimates.
// - A screen is a file the page's first load fetches with import() (src/workspace/screen-mounts.ts); nothing here lists screens.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The output files a file loads before it runs: itself and everything it imports statically, transitively.
const closureIn = outputs => function closure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const item of outputs[file].imports) if (item.kind === 'import-statement' && !item.external) closure(item.path, seen);
  return seen;
};

/** The source files (paths relative to the build's root, as the metafile names them) whose code the first load
 *  carries, read from a build's metafile. A virtual module (`namespace:path`) is left out, unless its path is a file
 *  on disk (a file a plugin hands the page part of, scripts/json-fields.mjs, named from `root` by ./ or ../): then it is that file. */
export function firstLoadInputs(metafile, entryPoint = 'src/workspace/main.tsx', root = '/') {
  const { outputs } = metafile;
  const entry = Object.keys(outputs).find(file => outputs[file].entryPoint === entryPoint);
  const inputs = new Set();
  for (const file of closureIn(outputs)(entry)) for (const input of Object.keys(outputs[file].inputs)) {
    const named = input.replace(/ with \{[^{}]*\}$/, '');
    const virtual = /^[a-z][a-z0-9-]*:(.*)$/i.exec(named);
    if (!virtual) inputs.add(named);
    else if (/^(\/|\.\.?\/)/.test(virtual[1]) && existsSync(resolve(root, virtual[1]))) inputs.add(virtual[1]);
  }
  return [...inputs];
}

export function workspaceSizes(metaPath, entryPoint = 'src/workspace/main.tsx') {
  const { outputs } = JSON.parse(readFileSync(metaPath, 'utf8'));
  const entry = Object.keys(outputs).find(file => outputs[file].entryPoint === entryPoint);
  const closure = closureIn(outputs);
  const bytesOf = files => [...files].reduce((sum, file) => sum + outputs[file].bytes, 0);
  const first = closure(entry);
  const screens = new Map();
  // The screens' import() calls sit in whichever first-load file holds the screens list, so every one of them is read.
  for (const file of first) for (const item of outputs[file].imports.filter(edge => edge.kind === 'dynamic-import')) {
    screens.set(outputs[item.path].entryPoint, bytesOf([...closure(item.path)].filter(other => !first.has(other))));
  }
  return { first_load_script_bytes: bytesOf(first), screens: Object.fromEntries(screens) };
}
