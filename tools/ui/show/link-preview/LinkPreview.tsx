// parts/ui/show/link-preview/LinkPreview.tsx
//
// PURPOSE
//   What a link is, shown the way the page describes itself rather than as a bare address: its picture across the
//   top, the site's own icon and name, its title, a line or two of what it says, and the address itself in small type,
//   with a slot at the end of the site line for the caller's buttons (copy, remove). Used wherever a person is about
//   to send, save or share a page, so a link reads the same in every one of those places.
//
// PROVENANCE
//   Anatomy from real save-a-page surfaces: Pinterest's save dialog (the thing on the left, big, before any choice:
//   mobbin.com/screens/8341475a-ec4e-45a1-8e31-813d834af9d8), Cosmos' save sheet (mobbin.com/screens/
//   a3d24572-61a1-474f-bd72-917f2c27edc9) and the link unfurl every chat app draws (picture, site line with its icon,
//   bold title, quiet description). Written fresh against the coss tokens; no source was copied.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: every word and picture is the caller's DATA; nothing here knows a site.
//   2. A picture or icon that fails to load is dropped, never drawn broken; with no picture the card is compact.
//   3. Text never overflows: the title stops after two lines, the description after two, the address after one.

import React from 'react';
import { cn } from '../cn';
import { NamedIcon } from '../icon';

export type LinkPreviewProps = {
  /** The address, shown small at the foot. */
  url: string;
  title: string;
  /** The site's name (og:site_name or its host). */
  site?: string | null;
  /** The site's own icon. */
  icon?: string | null;
  /** The page's picture (og:image). */
  picture?: string | null;
  description?: string | null;
  /** Why the page could not be fully read; a useful preview may still be shown. */
  unread?: string | null;
  /** Buttons at the end of the site line. */
  actions?: React.ReactNode;
  className?: string;
};

export function LinkPreview({ url, title, site, icon, picture, description, unread, actions, className }: LinkPreviewProps) {
  const [pictureFailed, setPictureFailed] = React.useState(false);
  const [iconFailed, setIconFailed] = React.useState(false);
  React.useEffect(() => { setPictureFailed(false); }, [picture]);
  React.useEffect(() => { setIconFailed(false); }, [icon]);
  const shownPicture = picture && !pictureFailed ? picture : null;
  return (
    <figure data-slot="link-preview" className={cn('m-0 min-w-0 overflow-hidden rounded-2xl border bg-card text-card-foreground', className)}>
      {shownPicture ? (
        <img data-link-preview-picture src={shownPicture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setPictureFailed(true)}
          className="block aspect-[1.91/1] w-full border-b object-cover bg-muted" />
      ) : null}
      <figcaption className="flex min-w-0 flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-muted">
            {icon && !iconFailed
              ? <img src={icon} alt="" referrerPolicy="no-referrer" onError={() => setIconFailed(true)} className="size-4 object-cover" />
              : <NamedIcon name="Globe" size="xs" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{site}</span>
          {actions ? <span className="-my-1 -me-1.5 flex shrink-0 items-center gap-0.5">{actions}</span> : null}
        </span>
        <span className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.01em]">{title}</span>
        {description ? <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{description}</span> : null}
        {unread ? <span role="status" data-slot="link-preview-unread" className="text-xs leading-snug text-muted-foreground">{unread}</span> : null}
        <span className="truncate text-[11px] text-muted-foreground/70">{url.replace(/^https?:\/\/(www\.)?/, '')}</span>
      </figcaption>
    </figure>
  );
}
