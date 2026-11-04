// tools/send-messages/do-work/read-the-worn-email-look.mjs
//
// Purpose
//   The look every email an email row sends is drawn in: the person's worn screen look, read through their records
//   door the way tool:read-current-worn-look reads it (tools/screen-looks/do-work/read-current-worn-look.mjs), with the
//   looks an account can wear (read-data/email-look.json `looks`) as its app DATA. do-work/mail-sender.mjs hands the
//   reader this file makes to read-data/draw-an-email.mjs currentPalette. It stands in for the older owner's
//   readBrandPresentationWithin (src/brand-assets.mjs), which read the operator's published brand from a Worker.
//
// Non-negotiable invariants
//   1. The look comes only from the person's records, through the four workspace records the email rows may read
//      (`screen-look`, `screen-look-own-themes`, `workspace-preference:screen-look-over-time`,
//      `workspace-preference:where-looks-apply`, the same rights as tool:read-current-worn-look). Nothing here names a
//      look: the person's choice decides, and with none it is `looks.start_with`, the shipped look.
//   2. A door that refuses, or an answer that holds no look, throws. currentPalette then refuses the email with
//      BRAND_UNREAD before any provider is asked. It is never drawn in other colours.
//   3. No device facts are given (host, device, place), so a look rule meant for one screen never picks an email's look.
//      The clock is UTC, so a scheduled change of look is worn by email at the same moment it is worn everywhere else.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCurrentWornLook } from '../../screen-looks/do-work/read-current-worn-look.mjs';
import { resolveScreenLookPalette } from '../../screen-looks/read-data/resolve-screen-look-palette.js';
import { EMAIL_LOOK } from '../read-data/draw-an-email.mjs';

const lookData = name => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'screen-look', name), 'utf8'));

/** The app DATA the worn-look reader is handed: the looks an account can wear, and the screen look's own plan and
 * rule settings (tools/screen-look/look-over-time.json, where-looks-apply.json). */
export const appData = () => ({ looks: EMAIL_LOOK.looks, look_over_time: lookData('look-over-time.json'), where_looks_apply: lookData('where-looks-apply.json') });

/** The reader currentPalette is handed: () → { palette } (the worn look's variables) through `door`. */
export function wornLookReader(door, { read = readCurrentWornLook, now } = {}) {
  return async () => {
    const answer = await read({ app_data: appData() }, { door, ...(now ? { now } : {}) });
    const look = answer?.worn_record?.payload;
    if (!look) throw new Error('The worn look was read, but it held no look.');
    return { palette: resolveScreenLookPalette(look) };
  };
}
