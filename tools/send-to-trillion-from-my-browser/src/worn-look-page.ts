// extension/src/worn-look-page.ts
//
// PURPOSE
//   Paints an extension page (the popup, the reply window, the attach, markup, sign-in and microphone pages) in the look
//   the person wears in Trillion, as the background worker keeps it (worn-look.mjs): settings.json `look` at once,
//   the kept worn look as soon as it is read, and again the moment a newer one is kept, while the page stays open.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page wears the worn look's own record through the shared resolver (applyChosenScreenLook); nothing here holds
//      a colour or a face.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { applyChosenScreenLook } from 'trillion-workshop/tools/screen-look/show/apply-chosen-screen-look.ts';
import looks from 'trillion-workshop/tools/choose-and-publish-screen-looks/src/workspace/looks.json' with { type: 'json' };
import settings from '../settings.json' with { type: 'json' };
import { KEY, kept } from './worn-look.mjs';

type Kept = { worn: string; record: unknown } | null;

/** Paints this page in the worn look, and again whenever a new one is kept. */
export function paintWithWornLook(): void {
  applyChosenScreenLook(looks.themes, settings.look);
  // The worn look's record first, so the person's own version of one of Trillion's looks wins over Trillion's.
  const wear = (value: Kept) => { if (value?.record) applyChosenScreenLook([value.record, ...looks.themes], value.worn); };
  kept().then(wear);
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[KEY]) wear(changes[KEY].newValue as Kept); });
}
