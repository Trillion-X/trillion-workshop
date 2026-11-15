// test-helpers/chromium.mjs
// The Chromium the browser tools' tests drive: Playwright's (a devDependency; `npx playwright install chromium` fetches
// it), started with tools/headless-browser's quiet switches first, the same switches every tool browser starts with.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { chromium } from 'playwright';

export const quietSwitches = JSON.parse(readFileSync(new URL('../tools/headless-browser/quiet-switches.json', import.meta.url), 'utf8')).switches;

/** chromium.launch with the quiet switches before the caller's own args. */
export const launchChromium = (options = {}) => chromium.launch({ ...options, args: [...quietSwitches, ...(options.args ?? [])] });

/** The executable a tool's own openBrowser starts (its BROWSER_EXECUTABLE). */
export const chromiumExecutable = () => chromium.executablePath();

/** Public browser dependencies remain readable when a sample gets a private HOME/profile. */
export function chromiumEnvironment() {
  const executable = chromiumExecutable();
  if (!existsSync(executable)) throw new Error('The browser samples need the installed Playwright Chromium; run npx playwright install chromium.');
  let build = dirname(executable);
  while (!/^chromium-\d+$/.test(basename(build)) && dirname(build) !== build) build = dirname(build);
  if (!/^chromium-\d+$/.test(basename(build))) throw new Error('The Playwright Chromium executable has no declared browser-cache build folder.');
  return { CHROME_PATH: executable, PLAYWRIGHT_BROWSERS_PATH: dirname(build) };
}
