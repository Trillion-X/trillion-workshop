// The environment a test's throwaway repositories run git in. Four tests (advance-shared-checkout, commit-on-current-main,
// commit-paths, hooks-from-main) each wrote this line themselves, and none stopped git from finding a real repository: an
// inherited GIT_DIR (a hook, a release script) or a fixture folder with no .git of its own under a folder inside a real
// checkout would send `git config core.hooksPath scripts/git-hooks` to that checkout, switching its hook chain off.
//   - the variables that tell git which repository it is in are removed (scripts/without-git-location.mjs);
//   - GIT_CEILING_DIRECTORIES stops git's search for a repository at `ceiling` (the temporary folder the fixtures are made in
//     unless a test says its own), so a fixture folder without a .git finds no repository rather than the one around it;
//   - the fixture's author and committer are named, so no real identity is read.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { withoutGitLocation } from '../../scripts/without-git-location.mjs';

export function fixtureGitEnv({ ceiling = tmpdir(), extra = {} } = {}) {
  return { ...withoutGitLocation(process.env), GIT_CEILING_DIRECTORIES: realpathSync(ceiling),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra };
}
