// parts/ui/show/file-preview/KeptFiles.tsx
//
// PURPOSE
//   Files something made, shown as the files themselves: each one drawn by the one file preview (a video or sound
//   plays, a picture shows, anything else shows its card), with its name under it and an Open button that goes to
//   the file. Used where a run's result holds files (a tool screen's "What it returned").
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: a file is its name, where its bytes are read from and its media type; what Open does is the caller's.
//   2. Nothing about a file is shown as data (no size, no identity): the file is shown, and named.
//   3. Appearance lives in screen-look/show/file-preview.css (.kept-files).
//   4. The preview's player is fetched the first time a file is shown, so a screen that can show kept files (a chat,
//      a tool's result) does not carry it until one is there; the name and Open show at once.
import { lazyPart } from '../load-later/later';
import * as React from 'react';
import { Button } from '../coss/ui/button';
import { NamedIcon } from '../icon/NamedIcon';

const FilePreview = lazyPart(() => import('./FilePreview'), module => module.FilePreview);

export type KeptFile = { key: string; name: string; url: string; contentType: string };

export function KeptFiles({ files, openLabel, onOpen }: { files: readonly KeptFile[]; openLabel: string; onOpen: (file: KeptFile) => void }) {
  if (!files.length) return null;
  return (
    <div className="kept-files" data-slot="kept-files">
      {files.map(file => (
        <div key={file.key} className="kept-file">
          <div className="kept-file-preview"><React.Suspense fallback={null}><FilePreview url={file.url} contentType={file.contentType} label={file.name} autoPlay={false} /></React.Suspense></div>
          <div className="kept-file-foot">
            <span className="kept-file-name">{file.name}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpen(file)}>
              <NamedIcon name="ArrowUpRight" size="sm" aria-hidden="true" />
              {openLabel}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
