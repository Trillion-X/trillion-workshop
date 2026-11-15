// extension/src/worn-look.mjs
//
// PURPOSE
//   The extension wears the look the person wears in Trillion, at run time. The background worker reads it from the
//   account (GET /mcp/api/looks/device, src/looks.mjs `device`) when it starts and every time it counts unread notices,
//   and keeps it in local storage (`worn-look`); every extension page paints itself in it (and again the moment a new
//   one is kept: worn-look-page.ts), and the toolbar badge takes its colours from it. settings.json `look` is only the first-launch look,
//   before the account ever answered, so wearing a look in Trillion repaints the extension without a new build.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No colour or face is decided here: a page wears the worn look's own record through the shared resolver
//      (applyChosenScreenLook), the badge a colour of the worn look's palette by its token name.
//   2. A look that cannot be read leaves the last kept one (or the first-launch look) in place; nothing waits on it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { deviceLook } from 'trillion-workshop/tools/screen-look/read-data/device-look-tokens.js';
import { resolveScreenLookButton, resolveScreenLookPalette } from 'trillion-workshop/tools/screen-look/read-data/resolve-screen-look-palette.js';
import looks from 'trillion-workshop/tools/choose-and-publish-screen-looks/src/workspace/looks.json' with { type: 'json' };
import settings from '../settings.json' with { type: 'json' };

export const KEY = 'worn-look';
export const kept = async () => (await chrome.storage.local.get(KEY))[KEY] ?? null;

/** Reads the worn look from the account (`account` is trillion.mjs account) and keeps it; answers whether it changed. */
export async function keepWornLook(account) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const answer = await account(`/looks/device?time_zone=${encodeURIComponent(zone)}`);
  if (!answer?.now?.colors || !answer?.worn_record) return false;
  const value = { worn: answer.worn, record: answer.worn_record, colors: answer.now.colors };
  const before = await kept();
  if (JSON.stringify(before) === JSON.stringify(value)) return false;
  await chrome.storage.local.set({ [KEY]: value });
  return true;
}

/** The first-launch look's colours as a device carries them (settings.json look, from the app's theme rows). */
function firstLaunchColors() {
  const theme = looks.themes.map(row => row.payload).find(payload => payload.id === settings.look) ?? looks.themes[0].payload;
  return deviceLook(theme, resolveScreenLookPalette(theme), resolveScreenLookButton(theme)).colors;
}

/** A colour of the worn look by its palette name, as the 0-255 [red, green, blue, alpha] chrome.action takes. */
export async function wornColor(token) {
  const channels = (await kept())?.colors?.[token] ?? firstLaunchColors()[token];
  return channels ? channels.map(value => Math.round(value * 255)) : null;
}
