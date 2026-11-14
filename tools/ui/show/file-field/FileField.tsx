// parts/ui/show/file-field/FileField.tsx
//
// PURPOSE
//   The one file field for every form; a form that adds its own file chooser or upload box repeats it. It takes a file
//   the person keeps: they choose it from their files (the one shared folder tree,
//   coss/project-tree.tsx, as a navigator in a popover, showing only files of the kind the field takes), or drop or
//   upload one (the licensed kibo Dropzone), and the field holds that file's id. The chosen file shows as the shared FileChip with a button to take it away.
//   Anatomy after Square's "Choose a file or drag and drop it here" box and Mintlify's "Select video" chooser with its
//   Upload tile (Mobbin 004704ad, 465c41fd) and 21st.dev 19201 "File Dropzone" (one file, kind checked on drop).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: where files are listed from and how one is uploaded are the caller's (`source`); this file names no
//      address, folder or product. What kind of file a field takes, and every word it says, is DATA (file-takes.json).
//   2. A field never takes a file of another kind: the chooser lists only files of its kind (folders stay, to walk
//      down), and a dropped or uploaded file of another kind is refused in words before any upload starts.
//   3. The value is only ever a file id the source answered (listed or uploaded); nothing is typed.
//   4. No markup of its own beyond layout: the Dropzone, ProjectTree, FileChip, Popover, Button and Spinner are the
//      shared parts; appearance lives in screen-look/show/file-field.css.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { X } from 'lucide-react';
import { LazyDropzone as Dropzone, LazyDropzoneEmptyState as DropzoneEmptyState } from '../kibo/LazyDropzone';
import { ProjectTree, type ProjectTreeItem } from '../coss/project-tree';
import { FileTree, type FileTreeNode } from '../file-tree';
import { FileChip, fileKindIcon } from '../file-chip';
import { Popover, PopoverPopup, PopoverTrigger } from '../coss/ui/popover';
import { Button } from '../coss/ui/button';
import { NamedIcon } from '../icon/NamedIcon';
import { Spinner } from '../spinner/Spinner';
import settings from './file-takes.json';
import { takesFile, takesOf } from './takes-file.mjs';

// What a file field takes is decided in one place, shared with the Worker's file cards (takes-file.mjs).
export { takesFile, takesOf };

/** One thing the source lists or uploaded: a file (`id` is the file's id) or a folder (`id` is its own path). */
export type FileFieldEntry = { id: string; name: string; folder: boolean; media_type?: string | null; path?: string };
/** Where files come from: everything in one folder (the top one is `root`), and one file uploaded, with its share
 *  done from 0 to 1 as it goes. */
export type FileFieldPage = { entries: FileFieldEntry[]; more: boolean };
export type FileFieldSource = {
  root: string;
  list: (folder: string) => Promise<FileFieldEntry[]>;
  /** A chooser-local page reader. The shared FileTree asks for another page only from its Show more button. */
  pages?: () => { list: (folder: string, page: number) => Promise<FileFieldPage> };
  upload: (file: File, onProgress: (share: number) => void, signal?: AbortSignal) => Promise<FileFieldEntry>;
};
export type FileFieldProps = {
  label: string;
  /** A `takes` id of file-takes.json; an id it does not have takes any file. */
  takes?: string;
  source?: FileFieldSource;
} & ({
  /** One listed or uploaded file id; scalar callers retain their existing contract. */
  multiple?: false;
  value: string;
  onChange: (value: string, entry?: FileFieldEntry) => void;
} | {
  /** Several listed or uploaded file ids, kept in selection order. */
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
});

const said = (words: string, fill: Record<string, string>) => words.replace(/\{(\w+)\}/g, (_all, key: string) => fill[key] ?? '');

const treeItem = (entry: FileFieldEntry): ProjectTreeItem => ({ id: entry.id, name: entry.name, manageable: false, ...(entry.folder ? { expandable: true } : { namedIcon: fileKindIcon(entry.media_type, entry.name) }) });
type Top = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; items: ProjectTreeItem[] };

export function FileField(props: FileFieldProps) {
  const { label, takes, source } = props;
  const multiple = props.multiple === true;
  const previousSource = React.useRef(source);
  const suppliedIds = props.multiple ? props.value : props.value ? [props.value] : [];
  const ids = previousSource.current === source ? suppliedIds : [];
  const selected = React.useRef(ids);
  selected.current = ids;
  const publish = (ids: string[]) => {
    if (props.multiple) props.onChange(ids);
    else props.onChange(ids[0] ?? '', entries.current.get(ids[0]));
  };
  const kind = takesOf(takes);
  const words = settings.words;
  const [chosen, setChosen] = React.useState<FileFieldEntry[]>([]);
  const [open, setOpen] = React.useState(false);
  const paged = React.useMemo(() => source?.pages?.(), [source, open]);
  const currentPages = React.useRef(paged);
  currentPages.current = paged;
  const [uploading, setUploading] = React.useState<{ name: string; share: number } | null>(null);
  const [problem, setProblem] = React.useState('');
  const entries = React.useRef(new Map<string, FileFieldEntry>());
  const uploadAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => uploadAbort.current?.abort(), []);
  const currentSource = React.useRef(source);
  const sourceEpoch = React.useRef(0);
  if (currentSource.current !== source) { sourceEpoch.current++; currentSource.current = source; }
  React.useEffect(() => () => { sourceEpoch.current++; }, []);
  React.useEffect(() => {
    if (previousSource.current === source) return;
    previousSource.current = source;
    uploadAbort.current?.abort();
    setUploading(null);
    entries.current.clear();
    selected.current = [];
    setChosen([]);
    setOpen(false);
    setProblem('');
    publish([]);
  }, [source]);
  const shown = ids.map(id => chosen.find(entry => entry.id === id) ?? entries.current.get(id)).filter((entry): entry is FileFieldEntry => Boolean(entry));

  const [top, setTop] = React.useState<Top>({ state: 'loading' });
  const select = (ids: string[]) => {
    const kept = [...new Set(ids)].filter(id => entries.current.has(id) && !entries.current.get(id)!.folder);
    selected.current = kept;
    setChosen(kept.map(id => entries.current.get(id)!));
    setProblem('');
    publish(kept);
  };
  const choose = (entry: FileFieldEntry) => {
    entries.current.set(entry.id, entry);
    select(multiple ? [...selected.current, entry.id] : [entry.id]);
  };
  // One folder as tree rows: its folders, to walk down, and only the files this field takes.
  const read = React.useCallback(async (folder: string) => {
    const epoch = sourceEpoch.current;
    const listed = await source!.list(folder);
    if (epoch !== sourceEpoch.current) return [];
    const kept = listed.filter(entry => entry.folder || takesFile(kind.accept, entry.media_type, entry.name));
    for (const entry of kept) entries.current.set(entry.id, entry);
    return kept.map(entry => ({ ...treeItem(entry), ...(multiple && entry.folder ? { selectable: false } : {}) }));
  }, [source, kind, multiple]);
  const readPage = React.useCallback(async (folder: FileTreeNode, page: number) => {
    const epoch = sourceEpoch.current;
    const got = await paged!.list(folder.id, page);
    if (epoch !== sourceEpoch.current || paged !== currentPages.current) throw new Error(words.failed);
    const kept = got.entries.filter(entry => entry.folder || takesFile(kind.accept, entry.media_type, entry.name));
    for (const entry of kept) entries.current.set(entry.id, entry);
    return { nodes: kept.map(entry => ({ id: entry.id, name: entry.name, folder: entry.folder, selectable: !entry.folder,
      ...(entry.folder ? {} : { icon: fileKindIcon(entry.media_type, entry.name) }) })), more: got.more };
  }, [paged, kind, words]);
  // The top folder is read each time the legacy chooser opens; paged sources are read by FileTree.
  React.useEffect(() => {
    if (!open || !source || paged) return;
    let live = true;
    setTop({ state: 'loading' });
    read(source.root).then(items => { if (live) setTop({ state: 'ready', items }); }, () => { if (live) setTop({ state: 'failed' }); });
    return () => { live = false; };
  }, [open, source, read, paged]);

  const upload = async (files: File[]) => {
    const given = multiple ? files : files.slice(0, 1);
    if (!given.length || !source) return;
    if (given.some(file => !takesFile(kind.accept, file.type, file.name))) { setProblem(said(words.not_taken, { noun: kind.noun })); return; }
    setProblem('');
    const cancellation = new AbortController();
    const epoch = sourceEpoch.current;
    uploadAbort.current = cancellation;
    for (const file of given) {
      setUploading({ name: file.name, share: 0 });
      try {
        const kept = await source.upload(file, share => { if (!cancellation.signal.aborted && epoch === sourceEpoch.current) setUploading({ name: file.name, share }); }, cancellation.signal);
        if (cancellation.signal.aborted || epoch !== sourceEpoch.current) return;
        choose(kept);
      }
      catch { if (!cancellation.signal.aborted && epoch === sourceEpoch.current) setProblem(said(words.upload_failed, { name: file.name })); break; }
      finally { if (epoch === sourceEpoch.current) setUploading(null); }
    }
  };

  const chip = (entry: FileFieldEntry) => (
    <div key={entry.id} className="file-field" data-chosen="">
      <FileChip name={entry.name} path={entry.path} media_type={entry.media_type} />
      <Button type="button" variant="ghost" size="icon-xs" aria-label={said(words.remove, { name: entry.name })} onClick={() => select(selected.current.filter(id => id !== entry.id))}>
        <X aria-hidden />
      </Button>
    </div>
  );
  if (shown.length && !multiple) return chip(shown[0]);

  return (
    <div className="file-field" role="group" aria-label={label}>
      {multiple ? shown.slice(0, settings.multiple.shown).map(chip) : null}
      {multiple && shown.length > settings.multiple.shown ? <span className="file-field-drop-words">{said(words.more_selected, { count: String(shown.length - settings.multiple.shown) })}</span> : null}
      {uploading ? (
        <div className="file-field-uploading" role="status">
          <Spinner aria-hidden />
          <span>{said(words.uploading, { name: uploading.name })}</span>
          <span className="file-field-share">{Math.round(uploading.share * 100)}%</span>
        </div>
      ) : (
        <Dropzone
          className="file-field-drop"
          aria-label={said(multiple ? words.drop_many : words.drop, { noun: kind.noun })}
          accept={kind.accept.length ? Object.fromEntries(kind.accept.map(type => [type, []])) : undefined}
          maxFiles={multiple ? 0 : 1}
          multiple={multiple}
          disabled={!source}
          onDrop={accepted => { void upload(accepted); }}
          onError={() => setProblem(said(words.not_taken, { noun: kind.noun }))}
        >
          <DropzoneEmptyState>
            <span className="file-field-drop-words">
              <NamedIcon name="Upload" size="sm" aria-hidden="true" />
              <span>{said(multiple ? words.drop_many : words.drop, { noun: kind.noun })}</span>
            </span>
          </DropzoneEmptyState>
        </Dropzone>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger disabled={!source || Boolean(uploading)} render={<Button type="button" variant="outline" size="sm" className="file-field-choose" />}>
          <NamedIcon name="FolderOpen" size="sm" aria-hidden="true" />
          {multiple ? words.choose_many : words.choose}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start" portalProps={{ className: 'coss-ui' }} className="file-field-chooser">
          {!open ? null : paged ? (
            <FileTree key={sourceEpoch.current}
              roots={[{ id: source!.root, name: words.root, folder: true, selectable: false }]}
              initiallyOpen={[source!.root]} load={readPage} label={words.root} selected={ids}
              selectionMode={multiple ? 'multiple' : 'single'}
              onSelectionChange={picked => {
                if (multiple) select(picked);
                else { const entry = entries.current.get(picked[0]); if (entry && !entry.folder) { choose(entry); setOpen(false); } }
              }}
              onOpen={node => { const entry = entries.current.get(node.id); if (entry && !entry.folder) { choose(entry); if (!multiple) setOpen(false); } }}
              emptyLabel={words.empty} loadingLabel={words.loading} failedLabel={words.failed} moreLabel={words.more}
            />
          ) : top.state === 'loading' ? (
            <div className="file-field-chooser-note" role="status"><Spinner aria-hidden />{words.loading}</div>
          ) : top.state === 'failed' ? (
            <p className="file-field-chooser-note" role="alert">{words.failed}</p>
          ) : (
            <ProjectTree
              onSelected={ids => { if (multiple) select(ids); }}
              options={{
                // The top folder is the tree's one open root, so every folder under it starts closed and reads itself when opened.
                items: [{ id: source!.root, name: words.root, children: top.items.map(item => item.id), manageable: false, selectable: false }, ...top.items],
                roots: [source!.root],
                label: words.root,
                selectionMode: multiple ? 'multiple' : 'none',
                selected: multiple ? ids : undefined,
                searchable: false,
                emptyLabel: words.empty,
                loadChildren: read,
                onOpen: id => {
                  const entry = entries.current.get(id);
                  if (entry && !entry.folder) { choose(entry); setOpen(false); }
                },
              }}
            />
          )}
        </PopoverPopup>
      </Popover>
      {problem ? <p className="file-field-problem" role="alert">{problem}</p> : null}
    </div>
  );
}
