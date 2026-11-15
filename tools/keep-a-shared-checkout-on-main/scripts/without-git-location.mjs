// scripts/without-git-location.mjs
//
// The environment a test run gets, without the variables that tell git which repository it is in. Tests make their
// own throwaway repositories and run git inside them; when the run inherits GIT_DIR (a git hook, a commit or release
// script), every `git config` and `git commit` such a test makes lands in the real checkout instead. On 2026-10-12 a
// release fixture's `git config user.name` reached this checkout's .git/config, and five commits on main went out
// under the fixture's name. Each test launcher passes its environment through this.
//
// Non-negotiable invariants
//   1. Only git's repository location and index variables are removed; everything else a test reads stays.
//   2. It never changes the caller's own environment: it answers a copy.

/** The variables git reads to find a repository, its work tree and its index. */
export const GIT_LOCATION_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES'];

/** A copy of `env` without git's location variables. */
export function withoutGitLocation(env = process.env) {
  const copy = { ...env };
  for (const name of GIT_LOCATION_VARIABLES) delete copy[name];
  return copy;
}
