// parts/ui/show/share-card/ShareSheet.tsx
//
// PURPOSE
//   Share a card of numbers through the one sharing sheet (sharing-sheet/SharingSheet.tsx): the card itself is the
//   preview, each place (an app, a message) opens at once, and Share (the device's own share sheet, with the picture
//   attached where the device allows), Copy link and Save image are its buttons. This file only makes the picture and
//   the link; the sheet draws everything.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is made public until the person presses a button: the first press makes the picture in this browser,
//      sends it with `create`, and every later press reuses that link.
//   2. The places are the caller's DATA rows (label, address with {url} and {text}, and a logo or a named icon); adding
//      one is a row, never a change here.
//   3. A place on the web opens in a window claimed at the moment of the press, so a browser that blocks windows opened
//      after a wait still lets it through.
//   4. Every failure is said in a notification by the sheet; a card that cannot be drawn still shares its link.

import React, { useRef } from 'react';
import { notify } from '../coss/notifications';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { downloadBlob } from '../file-download/download-file';
import { SharingSheet, type SharingPlace } from '../sharing-sheet/SharingSheet';
import { cardPng, shareCardSrc, type ShareCard } from './share-card';

export type SharePlace = { id: string; label: string; href: string; logo?: string; icon?: string };
export type ShareWords = { share: string; copy: string; copied: string; save: string; failed: string };
/** Makes (or refreshes) the public link for this card; `image_base64` is the card's PNG when this browser could draw it. */
export type CreateShare = (body: { image_base64?: string }) => Promise<{ url: string; text?: string }>;

const base64Of = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const filled = (href: string, link: { url: string; text: string }) => href.replace(/\{url\}/g, encodeURIComponent(link.url)).replace(/\{text\}/g, encodeURIComponent(link.text));

export function ShareSheet({ card, text, places, words, create }: { card: ShareCard; text: string; places: SharePlace[]; words: ShareWords; create: CreateShare }) {
  const made = useRef<Promise<{ url: string; text: string; png: Blob | null }> | null>(null);

  // The picture and the link, made once per sheet (invariant 1); a failed attempt can be tried again.
  const link = () => {
    made.current ??= (async () => {
      const png = await cardPng(card).catch(() => null);
      const answer = await create(png ? { image_base64: await base64Of(png) } : {});
      return { url: answer.url, text: answer.text ?? text, png };
    })();
    made.current.catch(() => { made.current = null; });
    return made.current;
  };

  const share = async () => {
    const made = await link();
    const file = made.png ? new File([made.png], 'progress.png', { type: 'image/png' }) : null;
    const data: ShareData = { title: card.headline, text: made.text, url: made.url };
    if (file && navigator.canShare?.({ ...data, files: [file] })) return navigator.share({ ...data, files: [file] });
    if (navigator.share) return navigator.share(data);
    if (await copyTextToClipboard(made.url)) notify(words.copied, { kind: 'copy' });
  };
  const copy = async () => {
    const made = await link();
    if (await copyTextToClipboard(made.url)) notify(words.copied, { kind: 'copy' });
  };
  const save = async () => {
    downloadBlob(await cardPng(card).catch(() => { throw new Error(words.failed); }), 'progress.png');
  };
  // Claimed now, while the press is still the reason (invariant 3); pointed at the place once the link exists.
  const open = async (place: SharingPlace) => {
    const href = place.href ?? '';
    const onWeb = /^https?:/.test(href);
    const opened = onWeb ? window.open('', '_blank') : null;
    try {
      const address = filled(href, await link());
      if (!onWeb) location.href = address;
      else if (opened) { opened.opener = null; opened.location.href = address; }
      else window.open(address, '_blank', 'noopener');
    } catch (error) { opened?.close(); throw error; }
  };

  return (
    <SharingSheet
      preview={{ image: { src: shareCardSrc(card), alt: card.headline, width: 1200, height: 630 } }}
      places={places}
      words={{ preview: card.headline, places: words.share, failed: words.failed }}
      onOpen={open}
      actions={[
        { id: 'share', label: words.share, primary: true, run: share },
        { id: 'copy', label: words.copy, icon: 'Link', run: copy },
        { id: 'save', label: words.save, icon: 'Download', run: save },
      ]}
    />
  );
}
