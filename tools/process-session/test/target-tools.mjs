// Test-only discovery of genuine target utilities; production commands are never translated for the host.
import { accessSync, constants, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Find an executable that identifies itself as GNU coreutils mv, regardless of its installed name. */
export function findGnuMove({ path = process.env.PATH ?? '', extraDirectories = ['/opt/homebrew/bin', '/usr/local/bin'] } = {}) {
  const directories = [...new Set([...path.split(delimiter), ...extraDirectories].filter(directory => directory && isAbsolute(directory)))];
  const checked = new Set();
  for (const directory of directories) {
    for (const name of ['mv', 'gmv']) {
      const candidate = join(directory, name);
      let executable;
      try {
        accessSync(candidate, constants.X_OK);
        executable = realpathSync(candidate);
      } catch { continue; }
      if (checked.has(executable)) continue;
      checked.add(executable);
      const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
      if (version.status === 0 && /^mv \(GNU coreutils\) \S+/m.test(version.stdout ?? '')) return executable;
    }
  }
  throw new Error('These Linux shell fixtures require genuine GNU coreutils mv. Install coreutils so mv or gmv is on PATH (or in a standard package bin folder); BSD mv is not a substitute.');
}

/** Expose the real target executable under its Linux command name in a fixture-owned PATH folder. */
export function linkGnuMove(folder, options) {
  const executable = findGnuMove(options), destination = join(folder, 'mv');
  if (existsSync(destination)) {
    if (realpathSync(destination) !== executable) throw new Error(`The fixture already owns a different mv at ${destination}.`);
  } else symlinkSync(executable, destination);
  return executable;
}
