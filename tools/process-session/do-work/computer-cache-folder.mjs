// The cache folder of the computer this runs on. One rule for every computer: the folder the computer names in
// XDG_CACHE_HOME, or .cache in the home folder, then trillion. Nothing here asks what kind of computer it is.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function computerCacheFolder(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'trillion');
}
