// harness/wake-handlers/keep-web-chats.mjs
//
// Purpose
//   Keeps the person's web chat conversations in their Trillion within half an hour, beside the wake-sessions helper
//   (a KeepAlive LaunchAgent): at start and every `every_seconds` of keep-web-chats.json it runs one pass of
//   harness/keep-web-chats.mjs with the helper's own account key, so a conversation whose AI could not write to
//   Trillion still lands.
//
// Non-negotiable invariants
//   1. It takes no events (wants is always false); which sites are read and how live in keep-web-chats.json.
//   2. One pass at a time: a pass still running when the next is due is left to finish.
//
import { keepWebChats, settings } from '../keep-web-chats.mjs';

export const wants = () => false;
export const handle = () => null;
export const start = ({ key, origin, log = () => {}, pass = keepWebChats } = {}) => {
  let running = null;
  const once = () => {
    if (!running) running = pass({ origin, key, log })
      .then(results => results.forEach(result => log(`keep-web-chats: ${result.site}: ${result.said}`)))
      .catch(error => log(`keep-web-chats: ${error.message}`))
      .finally(() => { running = null; });
    return running;
  };
  once();
  return setInterval(once, settings.every_seconds * 1000);
};
