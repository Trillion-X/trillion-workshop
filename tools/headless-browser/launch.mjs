// Every Chromium a script or test starts on this computer uses the shared
// admission queue and the quiet switches so it cannot prompt for keychain use.
import { readFileSync } from 'node:fs';
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
export const launchChromium = (options = {}) => launchWithAdmission(settings => chromium.launch(settings), options, 'disconnected');

/** chromium.launchPersistentContext with quiet switches and exclusive local-browser admission. */
export const launchPersistentChromium = (profile, options = {}) =>
  launchWithAdmission(settings => chromium.launchPersistentContext(profile, settings), options, 'close');
