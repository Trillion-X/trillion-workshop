// src/ask-your-ai.mjs
//
// Purpose: the AI apps a person can hand something to in one press, each with the address that opens a new chat in
// that app holding the words. Read by the Ask your AI button of every failure (src/workspace/failure.ts, the shared
// screen-state part draws it), by the failure pages a browser sees (src/browser-pages.mjs) and by the Open button
// beside each app's connect steps (src/ai-app-guides.mjs), so the apps and their addresses live in one place.
//
// Invariants:
//   - The apps and their addresses are DATA: a client row of src/ai-clients.json with `open_chat`. A new app is a row.
//   - The page carries only the client fields read here (scripts/browser-json-fields.json); read a new one, list it there.
//   - Browser-safe: the workspace bundle imports this file.
//   - The words go into the address encoded; an app whose address takes no words (`paste`), or whose address takes
//     fewer than the words hold (`max_chars`), gets the bare address and the words ride along for the caller to copy.
//   - An app that takes a command rather than a chat (a terminal app) carries its own `connect_words`: the line to run.
//   - Addresses are not only web addresses: a desktop app's own scheme (claude-cli://, codex://, cursor://) opens the
//     installed app with the words in its input, never sent for the person (every one of them waits for Send).
//
import clients from './ai-clients.json' with { type: 'json' };
import { logoOf } from './site-icon-url.mjs';

/** The name the person's chosen AI app is remembered under (parts/ui/show/ai-picker remembered choice), and the cookie
 *  a server page reads it from. */
export const CHOSEN_AI = 'ai';
export const CHOSEN_AI_COOKIE = 'trillion_choice_ai';

/** What opening one app holds and where it goes: when connecting, the app's own `connect_words` (a terminal app is
 *  given its add line, not the general message; `fill` fills it), and its address with the words in it, or its bare address with the words to copy when the app's
 *  address cannot carry them (`paste`, or words longer than the app takes: `max_chars`). */
function opening(client, prompt, fill) {
  const open = client.open_chat;
  const words = fill && open.connect_words ? fill(open.connect_words) : prompt;
  const fits = !open.paste && !(open.max_chars && words.length > open.max_chars);
  if (fits) return { words, href: String(open.href).replace('{prompt}', encodeURIComponent(words)) };
  return { words, href: open.bare ?? String(open.href).replace(/[?#].*$/, ''), paste: true };
}

/** Every AI app that opens a chat from an address, in the rows' order: { id, label, picture, href, paste, words }.
 *  `fill`, given only when connecting, fills an app's own `connect_words` ({mcp}, say); an app with none is given
 *  `prompt`. */
export const askChoices = (prompt, fill = null) => clients.clients.filter(client => client.open_chat?.href).map(client => {
  const { words, href, paste } = opening(client, prompt, fill);
  return {
    id: client.id,
    label: client.label,
    ...(client.domain ? { picture: logoOf(client.domain) } : {}),
    href,
    ...(paste ? { paste: true } : {}),
    words,
  };
});

/** The chosen AI app's id from a request's cookies, or null. */
export function chosenAiOf(cookieHeader) {
  const found = String(cookieHeader ?? '').split(/;\s*/).find(part => part.startsWith(`${CHOSEN_AI_COOKIE}=`));
  const id = found ? decodeURIComponent(found.slice(CHOSEN_AI_COOKIE.length + 1)) : null;
  return id && clients.clients.some(client => client.id === id && client.open_chat?.href) ? id : null;
}
