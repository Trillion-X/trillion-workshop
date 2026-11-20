// Every Chromium a script or test starts on this computer uses the shared
// admission queue and the quiet switches so it cannot prompt for keychain use.
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { acquireBrowserAdmission } from './admission.mjs';

export const quietSwitches = JSON.parse(readFileSync(new URL('./quiet-switches.json', import.meta.url), 'utf8')).switches;

const quiet = (options = {}) => ({ ...options, args: [...quietSwitches, ...(options.args ?? [])] });

async function launchWithAdmission(start, options, closeEvent) {
  const { admission: requestedAdmission, ...playwrightOptions } = options ?? {};
  const guardPriority = Number(process.env.TRILLION_BROWSER_ADMISSION_PRIORITY ?? 0);
  const release = await acquireBrowserAdmission({ priority: guardPriority, ...requestedAdmission });
  try {
    const opened = await start(quiet(playwrightOptions));
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      void release().catch(() => {});
    };
    opened.once(closeEvent, finish);
    return opened;
  } catch (error) {
    await release();
    throw error;
  }
}

/** chromium.launch with quiet switches and exclusive local-browser admission. */
/**
 * The executable a run's fetched program is found by: the first file named `name` on PATH that can be run, or undefined.
 * The engine puts a fetched program's folder on the run's PATH, so a row that fetches a headless shell finds it here.
 */
export function onThisPath(name, path = process.env.PATH ?? '') {
  for (const folder of path.split(':')) {
    if (!folder) continue;
    const file = join(folder, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch { /* not in this folder */ }
  }
  return undefined;
}

export const launchChromium = (options = {}) => launchWithAdmission(settings => chromium.launch(settings), options, 'disconnected');

/** chromium.launchPersistentContext with quiet switches and exclusive local-browser admission. */
export const launchPersistentChromium = (profile, options = {}) =>
  launchWithAdmission(settings => chromium.launchPersistentContext(profile, settings), options, 'close');
