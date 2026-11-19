// tools/better-auth-official/pages/busy.mjs
//
// The one answer to "the sign-in server is busy": a 429 or any 5xx. The sentence is the terminal's own DATA, words.sign_in_busy in
// tools/use-your-tools-from-a-shell/do-work/command.json: build-pages.mjs hands the pages that one sentence (no second copy here). The sentence
// names the site with {site_name}, which the pages fill with their own site name. Tested by test/busy.test.mjs.

export const isBusy = status => status === 429 || (Number.isInteger(status) && status >= 500);
export const busyWords = (sentence, siteName) => sentence.replaceAll('{site_name}', siteName);
