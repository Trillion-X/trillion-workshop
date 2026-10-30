// test-helpers/chromium.mjs
// The Chromium the browser tools' tests drive: Playwright's (a devDependency; `npx playwright install chromium` fetches
// it), started with tools/headless-browser's quiet switches first, the same switches every tool browser starts with.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

export const quietSwitches = JSON.parse(readFileSync(new URL('../tools/headless-browser/quiet-switches.json', import.meta.url), 'utf8')).switches;

/** chromium.launch with the quiet switches before the caller's own args. */
export const launchChromium = (options = {}) => chromium.launch({ ...options, args: [...quietSwitches, ...(options.args ?? [])] });

/** The executable a tool's own openBrowser starts (its BROWSER_EXECUTABLE). */
export const chromiumExecutable = () => chromium.executablePath();
