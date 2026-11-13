// tools/publish-an-engine-release/do-work/git-ssh.mjs
//
// How the builder's git reaches a repository over SSH: with a read key of its own instead of a token. GitHub binds a deploy
// key to one repository, so each repository the builder reads over SSH has its own key file and git is told which one for
// each fetch (the engine repository's key is the receiver service's default; the web client repository's is named by
// `gitSshCommand` for that one fetch). No file, network or process here: only the command text.
import { settings } from './release-feed.mjs';

/** A repository git reaches over SSH. */
export const overSsh = url => /^(ssh:\/\/|git@)/.test(url);

/** The `GIT_SSH_COMMAND` that reads with the key in `keyFile`, only that key, never asking and learning a new host's key once. */
export const gitSshCommand = keyFile =>
  `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${settings.on_builder.repository_known_hosts}`;
