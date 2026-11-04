// src/page-account.mjs
//
// Purpose: a change the page makes is made for the account the page was drawn for. The page names that account with
// every write (the kept-answers store name the Worker wrote into it, src/kept-answers.mjs); the Worker refuses a write
// whose page account is not the signed-in one, so a tab left open across a sign-in as someone else never acts as them.
//
// Non-negotiable invariants
//   1. The name is worked out from the signed-in account alone, the same way the page was given it; nothing is stored.
//   2. A write with no name (an AI, a script, an older page) is not refused: only a page that names another account is.
//   3. Reads are never refused here, and the refusal says why in plain words (src/page-account.json).
import settings from './page-account.json' with { type: 'json' };
import { keptAnswerStore } from './kept-answers.mjs';

/** The refusal { status, error } for a write whose page was drawn for another account, or null. */
export function pageAccountRefusal(request, userId, url = new URL(request.url)) {
  if (!settings.methods.includes(request.method) || !url.pathname.startsWith(settings.path_prefix)) return null;
  const named = request.headers.get(settings.header);
  if (!named || named === keptAnswerStore(userId)) return null;
  return { status: 409, error: settings.words, failure_code: 'request-refused' };
}

export const pageAccountHeader = settings.header;
