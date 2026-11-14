// parts/ui/show/file-chip/FileChip.tsx
//
// PURPOSE
//   One file named anywhere in the app (a notification, a list row, a message): the icon of its kind, its name, and a
//   coloured badge for the folder or source it is in. The full path is never printed in the row: hovering, focusing or
//   pressing the chip opens a small popover with it. Anatomy after 21st.dev 19226 "Tag" (unlumen: rounded outlined tag
//   with a coloured mark) and 12351 "File Attachment" (an icon by the file's kind), and the file rows of Dropbox Dash
//   on Mobbin (icon, name, then a small coloured source mark).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: every word is the caller's (a name, a folder, a path); nothing here names a product, folder or service.
//   2. A file's kind icon and its folder's colour are DATA (file-kinds.json): the same folder has the same colour
//      everywhere, from its name alone, and a new kind of file is one row.
//   3. The path is shown only on hover, focus or press, in the shared coss Popover; the trigger is a real button named
//      by the file's name and folder, so it is reachable without a mouse.
//   4. Appearance is screen-look's (parts/screen-look/show/file-chip.css, the palette's [data-colour] hues); no colour here.
import React from 'react';
import { Popover, PopoverDescription, PopoverPopup, PopoverTrigger } from '../coss/ui/popover';
import { Button } from '../coss/ui/button';
import { NamedIcon } from '../icon';
import kinds from './file-kinds.json';

export interface FileChipValue {
  /** The file's name, as the row shows it ("Match point.mp4"). */
  name: string;
  /** Where it is, shown on hover or press ("/Projects/Clips/Clip one.mp4"). */
  path?: string;
  /** The folder or source it is in, drawn as the coloured badge ("Clips"). */
  folder?: string;
  /** Its media type ("video/mp4"), which picks its icon; its name's ending is read when this is missing. */
  media_type?: string | null;
}

export interface FileChipProps extends FileChipValue {
  /** Default above the chip: it opens on hover, so below would sit under the pointer. */
  side?: 'top' | 'bottom' | 'left' | 'right';
}

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 150;

/** The named icon for a file of this media type (or, without one, this name's ending). */
export function fileKindIcon(mediaType?: string | null, name?: string): string {
  const ending = name && name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const type = mediaType || (kinds.endings as Record<string, string>)[ending] || '';
  return kinds.families.find(family => type.startsWith(family.prefix))?.icon ?? kinds.fallback;
}

/** The palette hue a folder's badge is drawn in: always the same one for the same name. */
export function folderColour(folder: string): string {
  let hash = 0;
  for (let index = 0; index < folder.length; index += 1) hash = (hash * 31 + folder.charCodeAt(index)) | 0;
  return kinds.folder_colours[Math.abs(hash) % kinds.folder_colours.length];
}

export function FileChip({ name, path, folder, media_type: mediaType, side = 'top' }: FileChipProps) {
  const label = folder ? `${name}, in ${folder}` : name;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={OPEN_DELAY_MS}
        closeDelay={CLOSE_DELAY_MS}
        aria-label={label}
        data-slot="file-chip"
        render={<Button type="button" variant="ghost" size="xs" className="file-chip" />}
      >
        <NamedIcon name={fileKindIcon(mediaType, name)} size="xs" aria-hidden="true" data-slot="file-chip-icon" />
        <span className="file-chip-name">{name}</span>
        {folder ? <span className="file-chip-folder" data-colour={folderColour(folder)} data-slot="file-chip-folder">{folder}</span> : null}
      </PopoverTrigger>
      <PopoverPopup side={side} align="start" sideOffset={6} tooltipStyle className="max-w-96" data-slot="file-chip-path">
        <PopoverDescription className="file-chip-path">{path ?? name}</PopoverDescription>
      </PopoverPopup>
    </Popover>
  );
}

/** Several files in one row, each as its chip. */
export function FileChips({ files, side }: { files: readonly FileChipValue[]; side?: FileChipProps['side'] }) {
  if (!files.length) return null;
  return (
    <span className="file-chips" data-slot="file-chips">
      {files.map(file => <FileChip key={file.path ?? file.name} {...file} side={side} />)}
    </span>
  );
}
