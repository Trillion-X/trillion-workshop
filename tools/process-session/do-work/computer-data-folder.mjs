// The folder where the computer this runs on keeps an app's data: the one owner of that choice for the FTP receiver, the
// camera stream receiver and the local resource host (moved here from the two copies in those receivers).
// Open (docs/decouple-sweep.md): the branch below still names one kind of computer, because a Mac already keeps waiting
// files, receiver state and resource databases under Application Support. It goes when those files are carried by the
// computer itself; until then every other computer uses $XDG_DATA_HOME, or .local/share in its home folder.
import os from 'node:os';
import path from 'node:path';

/** This computer's folder for app data. */
export const appDataFolder = () => (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
