// The cache folder of the place this runs on. One rule for every place: the folder the place names in XDG_CACHE_HOME,
// or .cache in the home folder, then trillion. Nothing here asks what kind of place it is.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function placeCacheFolder(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'trillion');
}
