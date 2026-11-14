import React, { useRef } from 'react';
import { Button } from '../button';

/** A local folder chooser. The caller owns reading and saving the selected files. */
export function FolderPicker({ onFiles, disabled = false, label = 'Choose a folder' }: {
  onFiles: (files: File[]) => void; disabled?: boolean; label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <Button size="sm" variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
    <input ref={input} type="file" multiple hidden aria-label={label}
      {...{ webkitdirectory: '' }}
      onChange={event => { onFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
  </>;
}

/** A browser file chooser that leaves the selected files with the calling owner. */
export function FilePicker({ onFiles, disabled = false, label = 'Choose files', accept, variant = 'ghost', size }: {
  onFiles: (files: File[]) => void; disabled?: boolean; label?: string; accept?: string;
  variant?: React.ComponentProps<typeof Button>['variant']; size?: React.ComponentProps<typeof Button>['size'];
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <Button variant={variant} size={size} disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
    <input ref={input} type="file" multiple hidden accept={accept} aria-label={label}
      onChange={event => { onFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
  </>;
}
