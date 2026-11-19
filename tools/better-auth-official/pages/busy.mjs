// tools/better-auth-official/pages/busy.mjs
//
// The one answer to "the sign-in server is busy": a 429 or any 5xx. The words are the terminal's own DATA, words.sign_in_busy in
// tools/use-your-tools-from-a-shell/do-work/command.json, so the terminal and the sign-in pages say the same thing from one row. That sentence
// names the site with {site_name}, which the pages fill with their own site name. Bundled into assets/sign-in.js; tested by test/busy.test.mjs.
import command from '../../use-your-tools-from-a-shell/do-work/command.json' with { type: 'json' };

export const isBusy = status => status === 429 || (Number.isInteger(status) && status >= 500);
export const busyWords = siteName => command.words.sign_in_busy.replaceAll('{site_name}', siteName);
