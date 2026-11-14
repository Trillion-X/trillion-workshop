// packages/ui/show/file-preview/choose-file-viewer.ts
//
// PURPOSE
//   Which viewer shows a file, read from file-viewers.json: its media type first, its name's extension when the type
//   names nothing. The one place this is decided; FilePreview draws the viewer it names.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every kind of file and every viewer name lives in the DATA rows; this file names none.
//   2. First matching row wins; the row naming neither a type nor an extension catches everything else.
//   3. A row's `settings` travel to its viewer untouched; this file never reads them.

import fileViewers from './file-viewers.json';

type ViewerRow = { readonly type_prefix?: string; readonly extensions?: readonly string[]; readonly viewer: string; readonly settings?: Readonly<Record<string, unknown>> };

/** The viewer a file is drawn by, and what its row says about reading it (a table's `separator`). */
export interface FileView {
  readonly viewer: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}
const ROWS = (fileViewers as { rows: ViewerRow[] }).rows;
const UNNAMED = new Set((fileViewers as { unnamed_types: string[] }).unnamed_types);

/** The part of a name after its last dot, lower case; '' when there is none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A media type that says something about the bytes, lower case without parameters; '' when it names nothing. */
export function namedType(contentType: string | null | undefined): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return UNNAMED.has(type) ? '' : type;
}

/** The viewer a file with this media type and name is drawn by, with its row's settings. */
export function chooseFileView(file: { readonly contentType?: string | null; readonly name?: string | null }): FileView {
  const type = namedType(file.contentType);
  const extension = extensionOf(file.name ?? '');
  // A named type decides alone; the extension speaks only for a file whose type names nothing.
  const row = ROWS.find(candidate => (
    candidate.type_prefix !== undefined ? Boolean(type) && type.startsWith(candidate.type_prefix)
      : candidate.extensions !== undefined ? !type && candidate.extensions.includes(extension)
        : true
  ));
  return row ? { viewer: row.viewer, settings: row.settings } : { viewer: 'file' };
}

/** The viewer id for a file with this media type and name. */
export function chooseFileViewer(file: { readonly contentType?: string | null; readonly name?: string | null }): string {
  return chooseFileView(file).viewer;
}
