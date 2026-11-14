// parts/ui/show/share-card/LinkShareSheet.tsx
//
// PURPOSE
//   Share a link that already exists (a person's invite link, a sales page, a space's join address) through the one
//   sharing sheet (sharing-sheet/SharingSheet.tsx): the link itself is the preview, each place (an app, a message)
//   opens at once with the link and its words filled in, and Share (the device's own share sheet) and Copy link are
//   its buttons. Where ShareSheet first makes a card and its link, this one only hands over a link it was given.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The places are the caller's DATA rows (label, address with {url} and {text}, and a logo or a named icon);
//      adding one is a row, never a change here.
//   2. Nothing is made or sent by this sheet: every place and button uses the link as given.
//   3. Every failure is said in a notification by the sheet; a device without a share sheet copies the link instead.

import React from 'react';
import { notify } from '../coss/notifications';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { SharingSheet, type SharingPlace } from '../sharing-sheet/SharingSheet';
import type { SharePlace } from './ShareSheet';

export type LinkShareWords = { link: string; share: string; copy: string; copied: string; failed: string };
/** A link to share: its address, the words sent with it, a title for the device's share sheet, and where it can go. */
export type LinkShare = { url: string; text: string; title: string; places: SharePlace[]; words: LinkShareWords };

const filled = (href: string, url: string, text: string) => href.replace(/\{url\}/g, encodeURIComponent(url)).replace(/\{text\}/g, encodeURIComponent(text));

export function LinkShareSheet({ url, text, title, places, words }: LinkShare) {
  const copy = async () => {
    if (await copyTextToClipboard(url)) notify(words.copied, { kind: 'copy' });
    else throw new Error(words.failed);
  };
  const share = async () => {
    if (navigator.share) return navigator.share({ title, text, url });
    return copy();
  };
  const open = (place: SharingPlace) => {
    const address = filled(place.href ?? '', url, text);
    if (/^https?:/.test(address)) window.open(address, '_blank', 'noopener');
    else location.href = address;
  };
  return (
    <SharingSheet
      preview={{ fields: [{ id: 'link', label: words.link, value: url }] }}
      places={places}
      words={{ preview: title, places: words.share, failed: words.failed }}
      onOpen={open}
      actions={[
        { id: 'copy', label: words.copy, icon: 'Link', primary: true, run: copy },
        { id: 'share', label: words.share, icon: 'Share', run: share },
      ]}
    />
  );
}
