// parts/ui/show/coss/banner.tsx
//
// PURPOSE
//   One line across the top of a guide section, drawn from its `banner` DATA: an icon in a small tile, a title with a
//   line under it, and a value at the right, in a rounded bordered card; whatever the host places at its end
//   (the section's "learn more" button) sits after the value. Anatomy follows the Promethee leaderboard's standing
//   card a user captured: the terminal-mark tile, "Connected" over
//   "0 tokens this week", and the Leave / Learn more buttons at the right. Dropped from it: the previous/next arrows
//   (the caller sends one standing) and the dark palette.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: icon name, lines and value are the caller's DATA.
//   2. Appearance lives in screen-look/show/guide.css (`.banner-*`); the icon is named DATA (NamedIcon).

import * as React from 'react';
import { NamedIcon } from '../icon/NamedIcon';
import type { GuideBanner } from './guide';

export function Banner({ banner, end }: { banner: GuideBanner; end?: React.ReactNode }) {
  return (
    <div className="banner-card">
      {banner.icon ? <span className="banner-icon" aria-hidden><NamedIcon name={banner.icon} /></span> : null}
      <div className="banner-text">
        <p className="banner-title">{banner.title}</p>
        {banner.detail ? <p className="banner-detail">{banner.detail}</p> : null}
      </div>
      {banner.value ? <p className="banner-value">{banner.value}</p> : null}
      {end ? <div className="banner-end">{end}</div> : null}
    </div>
  );
}
