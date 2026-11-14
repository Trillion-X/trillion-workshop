// parts/ui/show/coss/logo.tsx
//
// PURPOSE
//   One company's or thing's mark: the picture at `src` in a small rounded tile, or a quiet glyph (`icon`, an app
//   window when none is named) when there is no picture or it does not load. A thing never gets letters: initials are
//   a person's, made only by the shared person mark (show/display-mark). Built on the licensed Coss Avatar (image with
//   a fallback), so a broken or missing logo never leaves an empty box.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no company: the picture and the name are the caller's DATA.
//   2. The mark is decoration beside a written name, so it is hidden from screen readers.

import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { NamedIcon } from '../icon/NamedIcon';

export function Logo({ src, name, icon, className }: { src?: string | null; name: string; icon?: string; className?: string }) {
  return (
    <Avatar className={className ? `logo ${className}` : 'logo'} aria-hidden>
      {src ? <AvatarImage src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className="logo-fallback" delay={src ? 400 : 0} title={name}><NamedIcon name={icon ?? 'AppWindow'} /></AvatarFallback>
    </Avatar>
  );
}
