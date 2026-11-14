// parts/ui/show/composer/Composer.tsx
//
// PURPOSE
//   The one message box for every screen; a screen that adds its own message box repeats it. A person uses it to send
//   anything at once: words (with `@` mentions of their people, AIs, workflows,
//   automations and actions, drawn as coloured chips), files (chosen, pasted or dropped onto it), a link (pasted),
//   their voice, a video from the camera and a recording of their screen. Everything waits in a tray
//   above the words until Send hands the whole message to the caller in one piece. The box is drawn where its caller
//   puts it (a screen, or the message box screen the screen arrangement floats over the work in a layer).
//
// NON-NEGOTIABLE INVARIANTS
//   1. It sends nothing itself: `onSend` receives { text, files, links, mentions } once and does the sending; its
//      answer (a line of words) is shown, and the box empties only when it succeeds. A failure keeps everything.
//   2. The message's state (words, tray, a running recording) lives here, above wherever the box is drawn.
//   3. Every word comes from composer-words.json unless the caller passes its own (`words`); what can be recorded, and
//      how, is the one recorder's DATA (parts/record-audio/read-data/capture-sources.json, recorded by
//      parts/record-audio/show/record-in-the-browser.ts, the same recorder the Record screen uses); what can be
//      mentioned and how each kind looks is the caller's DATA.
//   4. It never places itself over the page: floating over the work is the screen arrangement's layer, which moves,
//      resizes and docks the window that holds it.
//   5. Only shared parts draw it; the one element it makes itself is the file chooser the drop zone needs.
//   6. A way to record that this browser lacks is not offered.
//   7. Draw opens the drawing screen the words' DATA names (`draw.screen`, the board), with what it opens with
//      (`draw.input`, drawing already chosen), in the shared open choice `draw.opens_as` names (its own floating
//      window); where the DATA names no screen, Draw is not offered.
//   8. A picker the caller keeps `behind` a button is drawn only while the caller says it is open; the button and the
//      quiet status line beside it (Waiting to send) are drawn by shared parts from the caller's words.

import React from 'react';
import { lazyPart } from '../load-later/later';
import { useDropzone } from 'react-dropzone';

import { Button } from '../button';
import { Button as LinkButton } from '../coss/ui/button';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { fileKindIcon } from '../file-chip/FileChip';
import { Text } from '../text';
import { LinkPreview, type LinkPreviewProps } from '../link-preview';
import { RecordingBar } from '../recording-bar';
import { MediaPreview } from '../media-preview/MediaPreview';
import { ExpandableTabs } from '../expandable-tabs';
import { AddToIt } from '../add-to-it';
import { BorderBeam } from '../border-beam';
import { ActionMenu, type ActionMenuItem } from '../action-menu/ActionMenu';
import { MentionPicker, pickMentions, type MentionOption } from '../mention-picker';
import { RecordChip, type RecordChipKinds } from '../record-chip';
import {
  DEFAULT_EDITING_RULES, DocumentEditor, documentFromMarkdown, documentToMarkdown, emptyDocument, isDocumentEmpty, mentionsIn, mintBlockId,
  type DocumentEditorHandle, type DocumentValue, type MentionPickerRequest,
} from '../../../documents';
import { CAPTURE_SOURCES, canCapture, problemWords, startCapture, type Capture, type CaptureSource } from '../../../record-audio/show/record-in-the-browser';
import { PLACEABLE_SURFACE_MIME } from '../placeable-surface-intent/placeable-surface-intent';
import { OPEN_CHOICES, withOpenChoice } from '../placeable-surface-intent/open-choices';
import { linkInPaste } from './link-in-paste';
import { retryDraft } from './retry-draft';
import { liftAboveFloating } from '../floating-occlusion/lift-above-floating';
import defaultWords from './composer-words.json';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

// The next step a refusal names (`next: { label, href }`, kept by the app's request helper), or null.
const nextStepOf = (error: unknown) => {
  const next = (error as { next?: { label?: unknown; href?: unknown } } | null)?.next;
  return typeof next?.label === 'string' && typeof next.href === 'string' && /^(https:\/\/|\/)/.test(next.href) ? { label: next.label, href: next.href } : null;
};
import { sayHappened } from '../happened/happened';
// The camera's live picture is fetched with the first recording that shows one, so the box never loads the player first.
const MediaFrame = lazyPart(() => import('../media-frame/MediaFrame'), module => module.MediaFrame);

export type ComposerWords = typeof defaultWords;
/** One thing a message mentions, as it travels: its kind, its own id and its name. */
export type Mention = { kind: string; value: string; label: string };
/** Something the next message answers or carries (a reply, a file), shown as a small pill above the words. */
export interface ComposerContext {
  id: string;
  label: string;
  /** An icon name (DATA, drawn by NamedIcon). */
  icon?: string;
}

/** What Send hands over: the words as markdown (a mention as `@name`, a heading as `# `, a list as `- `), every file
 *  in the tray, every pasted link, and each thing mentioned. */
export type ComposerDraft = { text: string; files: File[]; links: string[]; mentions: Mention[] };
export type ComposerAction = { id: string; label: string; icon: string };
/** One choice in a picker; one with `options` is a folder of choices, opened as its own menu and never chosen itself.
 *  `depth` sets a choice in under the one above it (0 at the top), so choices given in tree order read as a tree. */
export type ComposerPickerOption = { value: string; label: string; icon: string; depth?: number; options?: readonly ComposerPickerOption[] };
/** One choice the message is sent with (where it goes, what the AI does), drawn as a menu above the box. It is shown
 *  only when there is something to choose: more than one option when several can be chosen, any option otherwise. */
export interface ComposerPicker {
  id: string;
  /** Before the current choice on the button ("Send to"). */
  label: string;
  icon: string;
  many: boolean;
  options: readonly ComposerPickerOption[];
  chosen: readonly string[];
  onChange: (chosen: string[]) => void;
  /** A search box over the options, and a row making a new option from the typed words (`label` fills `{name}`). */
  search?: { placeholder: string; create?: { label: string; icon?: string; onCreate: (name: string) => void } };
  /** A picker kept out of sight until the person asks for it (Choose where): the box draws one button, `label` while
   *  closed and `closeLabel` while open, and shows this picker only while `open`. Every picker that carries `behind`
   *  shares the one button (the first one's words and `onToggle` are used). `status` is a quiet line beside the button
   *  (Waiting to send), shown even when no picker has anything to choose. */
  behind?: { label: string; closeLabel: string; open: boolean; onToggle: () => void; status?: string };
}

/** One saved piece of writing the person puts into the box (a reply they give often): its title, a line of its words. */
export interface ComposerSnippet { id: string; title: string; detail?: string }
/** The person's snippets, offered as a menu beside the pickers: choosing one puts its words (the caller fills its blanks,
 *  `use`) at the caret. The caller owns what a snippet is and where it is kept. */
export interface ComposerSnippets {
  rows: readonly ComposerSnippet[];
  /** The words to put at the caret for one snippet; a refusal is shown as the box shows any refusal. */
  use: (id: string) => Promise<string>;
  /** A search box over the titles. */
  search?: { placeholder: string };
  /** Keeps the words now in the box as a new snippet (offered as the menu's first row while there are words). */
  save?: (words: string) => Promise<void>;
}

export interface ComposerProps {
  /** Does the sending; resolves with a line to show (what happened), or throws with words to show. */
  onSend: (draft: ComposerDraft) => Promise<string | void>;
  /** The caller's own words, over composer-words.json. */
  words?: Partial<Omit<ComposerWords, 'draw'>> & { draw?: Partial<ComposerWords['draw']> };
  /** Chips above the box (what this message answers), each removable through `onRemoveContext`. */
  context?: readonly ComposerContext[];
  onRemoveContext?: (id: string) => void;
  /** The caller's own ways to add (Share something already kept), drawn with the composer's own. */
  actions?: readonly ComposerAction[];
  onAction?: (id: string) => void;
  /** Reads a pasted link into the card its page describes itself with; until it answers (or when it fails) the link
   *  shows as its address and site. */
  readLink?: (url: string) => Promise<LinkPreviewProps>;
  /** What `@` offers and how each kind looks; `onMentionQuery` hears what is typed after `@` for a live search. */
  mentions?: readonly MentionOption[];
  mentionKinds?: RecordChipKinds;
  onMentionQuery?: (query: string | null) => void;
  /** What a host hands in to be sent (a share from another app): its words go after what is written, its files and
   *  links into the tray. Each `id` is added once. */
  incoming?: { id: string; text?: string; files?: readonly File[]; links?: readonly string[] } | null;
  /** Acknowledges that this incoming draft has joined the box, so its caller may offer the next one. */
  onIncomingTaken?: (id: string) => void;
  /** The choices this message is sent with, each a menu above the box (the caller owns them and what they mean). */
  pickers?: readonly ComposerPicker[];
  /** Saved pieces of writing to put into the words (snippets). */
  snippets?: ComposerSnippets;
  /** The message carries things the caller draws outside the box (picked things in a tray), so Send works with
   *  nothing written or attached. */
  carries?: boolean;
  /** The ways to add (attach, record, draw and the caller's own) drawn out in the open as the shared Add to it grid
   *  above the box, as the Send to Trillion popup and the iPhone sheet draw them, instead of folded into the tool row. */
  waysShown?: boolean;
  /** Hears the words as they are written (as Send would hand them, markdown), every change and the empty box after a
   *  send, so the caller can answer before Send (the screen the words pick, src/workspace/instant-screen.tsx). */
  onWordsChange?: (words: string) => void;
  disabled?: boolean;
}

type Attachment = { id: string; file?: File; link?: string; card?: LinkPreviewProps; picture?: string };

const endingOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '');
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
let counter = 0;
const nextId = () => `attachment:${Date.now()}:${counter += 1}`;

/** Every choice in a picker, folders opened, in order. */
const choicesIn = (options: readonly ComposerPickerOption[]): ComposerPickerOption[] => options.flatMap(option => (option.options ? choicesIn(option.options) : [option]));
const isChoosable = (picker: ComposerPicker) => choicesIn(picker.options).length > (picker.many ? 1 : 0);

/** One picker: its label and current choice on the button, its options (checked when chosen) in the shared menu. */
function PickerMenu({ picker, disabled }: { picker: ComposerPicker; disabled: boolean }) {
  const chosenLabels = choicesIn(picker.options).filter(option => picker.chosen.includes(option.value)).map(option => option.label);
  const rows = (options: readonly ComposerPickerOption[]): ActionMenuItem[] => options.map(option => (option.options
    ? { id: option.value, label: option.label, icon: option.icon, items: rows(option.options) }
    : { id: option.value, label: option.label, icon: option.icon, depth: option.depth, checked: picker.chosen.includes(option.value), keepOpen: picker.many }));
  const choose = (value: string) => {
    if (!picker.many) return picker.onChange([value]);
    picker.onChange(picker.chosen.includes(value) ? picker.chosen.filter(one => one !== value) : [...picker.chosen, value]);
  };
  return (
    <ActionMenu label={picker.label} iconTrigger={false} align="start" side="top"
      triggerProps={{ disabled, className: 'composer-picker' }}
      triggerContent={(
        <>
          <NamedIcon name={picker.icon} size="xs" aria-hidden="true" />
          <Text variant="caption">{picker.label}</Text>
          <Text variant="caption" className="composer-picker-choice">{chosenLabels.join(', ') || '—'}</Text>
          <NamedIcon name="ChevronDown" size="xs" aria-hidden="true" />
        </>
      )}
      items={rows(picker.options)}
      onAction={choose}
      search={picker.search} />
  );
}

const SAVE_ROW = '__save-as-snippet';

/** The snippets menu: choosing one puts its filled words at the caret; the box keeps the caret and the rest of the words. */
function SnippetMenu({ snippets, label, saveLabel, written, disabled, put, failed }: { snippets: ComposerSnippets; label: string; saveLabel: string; written: string; disabled: boolean; put: (words: string) => void; failed: (error: unknown) => void }) {
  return (
    <ActionMenu label={label} iconTrigger={false} align="start" side="top"
      triggerProps={{ disabled, className: 'composer-picker' }}
      triggerContent={(<><NamedIcon name="TextCursorInput" size="xs" aria-hidden="true" /><Text variant="caption">{label}</Text><NamedIcon name="ChevronDown" size="xs" aria-hidden="true" /></>)}
      items={[...(snippets.save && written.trim() ? [{ id: SAVE_ROW, label: saveLabel, icon: 'BookmarkPlus', group: 'save' }] : []), ...snippets.rows.map(row => ({ id: row.id, label: row.title, icon: 'TextQuote', ...(row.detail ? { hint: row.detail } : {}) }))]}
      onAction={id => { if (id === SAVE_ROW) snippets.save?.(written).catch(failed); else snippets.use(id).then(put, failed); }}
      {...(snippets.search ? { search: snippets.search } : {})} />
  );
}

function mergeWords(given: ComposerProps['words']): ComposerWords {
  return { ...defaultWords, ...given, draw: { ...defaultWords.draw, ...given?.draw } } as ComposerWords;
}

function TrayTile({ item, removeLabel, onRemove }: { item: Attachment; removeLabel: string; onRemove: () => void }) {
  const remove = (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={removeLabel} onClick={onRemove}>
      <NamedIcon name="X" size="xs" aria-hidden="true" />
    </Button>
  );
  if (item.link) {
    const host = new URL(item.link).host;
    return <Container role="listitem" width="full" className="max-w-72"><LinkPreview {...(item.card ?? { url: item.link, title: host, site: host })} actions={remove} /></Container>;
  }
  const file = item.file as File;
  return (
    <Container role="listitem" layout="horizontal" gap="xs" alignItems="center" rounded="lg" border="all" background="primary" padding="xs" className="max-w-60">
      <Container className="h-12 w-12 shrink-0 overflow-hidden rounded-[var(--radius-control)]">
        <MediaPreview renderer={item.picture ? 'image' : 'type-icon'} {...(item.picture ? { source: item.picture } : {})}
          title={file.name} icon={fileKindIcon(file.type, file.name)} typeLabel={endingOf(file.name)} />
      </Container>
      <Text variant="caption" color="secondary" className="min-w-0 flex-1 truncate">{file.name}</Text>
      {remove}
    </Container>
  );
}

/** What `@` opens in the words: the shared MentionPicker over the caller's candidates. The words keep the caret; the
 *  editor hands the picker Arrow Up/Down to move, Enter or Tab to choose, and Escape to close. */
function MentionMenu({ request, candidates, kinds, label, allLabel, onQuery }: {
  request: MentionPickerRequest; candidates: readonly MentionOption[]; kinds: RecordChipKinds; label: string; allLabel: string;
  onQuery?: (query: string | null) => void;
}) {
  const [kind, setKind] = React.useState<string | null>(null);
  const [highlighted, setHighlighted] = React.useState(0);
  const shown = React.useMemo(() => pickMentions(candidates, kinds, request.query, kind), [candidates, kinds, request.query, kind]);
  const live = React.useRef({ shown, highlighted, choose: request.choose });
  live.current = { shown, highlighted, choose: request.choose };
  React.useEffect(() => { setHighlighted(0); }, [request.query, kind]);
  React.useEffect(() => { onQuery?.(request.query); }, [onQuery, request.query]);
  React.useEffect(() => () => onQuery?.(null), [onQuery]);
  const { keys } = request;
  React.useEffect(() => {
    keys(key => {
      const { shown: rows, highlighted: at, choose } = live.current;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        if (!rows.length) return false;
        setHighlighted((at + (key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
        return true;
      }
      const picked = rows[at];
      if ((key === 'Enter' || key === 'Tab') && picked) { choose({ kind: picked.kind, value: picked.value, label: picked.label }); return true; }
      return false;
    });
    return () => keys(null);
  }, [keys]);
  return (
    <MentionPicker candidates={candidates} kinds={kinds} query={request.query} kind={kind} onKindChange={setKind}
      highlighted={highlighted} onHighlight={setHighlighted} label={label} allLabel={allLabel}
      onChoose={option => request.choose({ kind: option.kind, value: option.value, label: option.label })} />
  );
}

export function Composer({
  onSend, words: given, context = [], onRemoveContext, actions = [], onAction, readLink, mentions, mentionKinds, onMentionQuery,
  incoming, onIncomingTaken, pickers = [], snippets, carries = false, waysShown = false, onWordsChange, disabled = false,
}: ComposerProps) {
  const words = React.useMemo(() => mergeWords(given), [given]);
  const [doc, setDoc] = React.useState<DocumentValue>(() => emptyDocument(DEFAULT_EDITING_RULES, mintBlockId));
  const docRef = React.useRef(doc);
  docRef.current = doc;
  // The words reach the caller before the browser paints them, so an answer to them can paint in the same frame.
  const hearWords = React.useRef(onWordsChange);
  hearWords.current = onWordsChange;
  React.useLayoutEffect(() => { hearWords.current?.(documentToMarkdown(doc, DEFAULT_EDITING_RULES)); }, [doc]);
  const editor = React.useRef<DocumentEditorHandle | null>(null);
  const [tray, setTray] = React.useState<Attachment[]>([]);
  const [busy, setBusy] = React.useState(false);
  const pendingSend = React.useRef<ComposerDraft | null>(null);
  // What happened to the last send, and the one next step its answer names (`next` on a refusal: Connect your AI).
  const [said, setSaid] = React.useState<{ text: string; failed: boolean; next?: { label: string; href: string } } | null>(null);
  // What the box answers sits under it, so on a short screen it can land below the fold. It comes into view when it
  // appears and again whenever it grows (its button mounts a moment after its words), so all of it ends up in view.
  const saidRef = React.useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => node.scrollIntoView?.({ block: 'nearest' }));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  const [capture, setCapture] = React.useState<Capture | null>(null);
  const trayRef = React.useRef(tray);
  trayRef.current = tray;

  const addFiles = React.useCallback((files: readonly File[]) => {
    const fresh = files.filter(file => file.size > 0).map(file => ({ id: nextId(), file, ...(file.type.startsWith('image/') ? { picture: URL.createObjectURL(file) } : {}) }));
    if (fresh.length) setTray(current => [...current, ...fresh]);
  }, []);
  const addLink = React.useCallback((link: string) => {
    if (trayRef.current.some(item => item.link === link)) return;
    const id = nextId();
    setTray(current => [...current, { id, link }]);
    readLink?.(link).then(card => setTray(current => current.map(item => (item.id === id ? { ...item, card } : item))), () => undefined);
  }, [readLink]);
  // A host's handed-in draft joins what is already here, once per id.
  const takenIncoming = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!incoming || takenIncoming.current === incoming.id) return;
    takenIncoming.current = incoming.id;
    if (incoming.text?.trim()) {
      const before = documentToMarkdown(docRef.current, DEFAULT_EDITING_RULES).trim();
      setDoc(documentFromMarkdown([before, incoming.text.trim()].filter(Boolean).join('\n\n'), DEFAULT_EDITING_RULES, mintBlockId));
    }
    if (incoming.files?.length) addFiles(incoming.files);
    for (const link of incoming.links ?? []) addLink(link);
    onIncomingTaken?.(incoming.id);
  }, [incoming, addFiles, addLink, onIncomingTaken]);
  const remove = React.useCallback((id: string) => {
    setTray(current => current.filter(item => {
      if (item.id !== id) return true;
      if (item.picture) URL.revokeObjectURL(item.picture);
      return false;
    }));
  }, []);
  // Pictures made for the tray are let go when the box goes away.
  React.useEffect(() => () => { for (const item of trayRef.current) if (item.picture) URL.revokeObjectURL(item.picture); }, []);

  // A pending capture still belongs to the box that asked for it, even before it reaches state.
  const captureOwner = React.useRef({ mounted: true, request: 0, starting: false, current: null as Capture | null });
  React.useEffect(() => {
    const owner = captureOwner.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.request += 1;
      owner.starting = false;
      owner.current?.discard();
      owner.current = null;
    };
  }, []);

  const record = async (source: CaptureSource) => {
    const owner = captureOwner.current;
    if (!owner.mounted || owner.starting || owner.current) return;
    owner.starting = true;
    const request = ++owner.request;
    const current = () => owner.mounted && owner.request === request;
    setSaid(null);
    try {
      const running = await startCapture(source, {
        // The browser stopped it by itself (a device unplugged, a screen share ended): what it made joins the tray.
        onEnded: (recorded, said) => {
          if (!current()) return;
          owner.current = null;
          owner.request += 1;
          owner.starting = false;
          setCapture(null); addFiles([recorded.file]); setSaid({ text: said, failed: false });
        },
        onProblem: said => { if (current()) setSaid({ text: said, failed: true }); },
      });
      if (!current()) { running.discard(); return; }
      owner.current = running;
      setCapture(running);
    } catch (error) {
      if (current()) setSaid({ text: problemWords(error, source), failed: true });
    } finally {
      if (owner.request === request) owner.starting = false;
    }
  };
  const stopRecording = async () => {
    const owner = captureOwner.current;
    const running = owner.current;
    if (!running) return;
    owner.current = null;
    owner.request += 1;
    setCapture(null);
    const recorded = await running.stop();
    if (owner.mounted) addFiles([recorded.file]);
  };
  const discardRecording = () => {
    const owner = captureOwner.current;
    owner.current?.discard();
    owner.current = null;
    owner.request += 1;
    setCapture(null);
  };

  const send = async () => {
    if (busy || disabled) return;
    if (capture) await stopRecording();
    const written = documentToMarkdown(docRef.current, DEFAULT_EDITING_RULES).trim();
    const files = trayRef.current.flatMap(item => (item.file ? [item.file] : []));
    const links = trayRef.current.flatMap(item => (item.link ? [item.link] : []));
    if (!written && !files.length && !links.length && !carries) return;
    setBusy(true);
    setSaid(null);
    try {
      const draft = retryDraft(pendingSend.current, { text: written, files, links, mentions: mentionsIn(docRef.current) });
      pendingSend.current = draft;
      const answer = await onSend(draft);
      pendingSend.current = null;
      for (const item of trayRef.current) if (item.picture) URL.revokeObjectURL(item.picture);
      setTray([]);
      setDoc(emptyDocument(DEFAULT_EDITING_RULES, mintBlockId));
      setSaid(answer ? { text: answer, failed: false } : null);
      sayHappened({ event_kind: 'message-sent', target: rootRef.current });
    } catch (error) {
      const next = nextStepOf(error);
      // A refusal that names its next step is an answer, said calmly with its button, not an alarm.
      setSaid(next ? { text: errorWords(error), failed: false, next } : { text: errorWords(error), failed: true });
      sayHappened({ event_kind: 'message-failed', target: rootRef.current });
    } finally { setBusy(false); }
  };

  const { getRootProps, getInputProps, isDragActive, open: chooseFiles, rootRef } = useDropzone({ noClick: true, noKeyboard: true, multiple: true, onDrop: addFiles, disabled: disabled || busy });
  // A box pinned at the bottom of its screen lifts above a control floating over the window's bottom edge.
  React.useEffect(() => (rootRef.current ? liftAboveFloating(rootRef.current) : undefined), [rootRef]);

  const sources = CAPTURE_SOURCES.filter(canCapture);
  const ownActions: ComposerAction[] = [
    ...sources.map(source => ({ id: `record:${source.id}`, label: source.label, icon: source.icon })),
    ...(words.draw.screen ? [{ id: 'draw', label: words.draw.open, icon: words.draw.icon }] : []),
    ...actions,
  ];
  // Draw opens the drawing screen its DATA names, as the sidebar opens a screen, with what that screen opens with, in
  // the shared place its DATA names (`opens_as`, an open-choices.json row): its own window, never a split of the box's.
  const draw = () => {
    const request = { id: words.draw.screen, title: words.draw.title, surfaceInput: words.draw.input };
    const choice = OPEN_CHOICES.find(one => one.id === words.draw.opens_as);
    window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: choice ? withOpenChoice(request, choice) : request }));
  };
  const act = (id: string) => {
    const source = sources.find(one => `record:${one.id}` === id);
    if (source) { void record(source); return; }
    if (id === 'draw') { draw(); return; }
    onAction?.(id);
  };
  // `@` is offered when the caller has things to mention (or searches for them as they are typed).
  const offersMentions = Boolean(mentions?.length || onMentionQuery);
  const more: ComposerAction[] = [
    { id: 'attach', label: words.attach, icon: 'Paperclip' },
    ...(offersMentions ? [{ id: 'mention', label: words.mention, icon: 'AtSign' }] : []),
    ...ownActions,
  ];
  const chooseMore = (id: string) => {
    if (id === 'attach') chooseFiles();
    else if (id === 'mention') editor.current?.insertText('@');
    else act(id);
  };
  // Files and a pasted link go to the tray (the paste handler on the box); every other paste is words.
  const claimsPaste = (data: DataTransfer) => data.files.length > 0 || linkInPaste(data.getData('text/plain')) !== null;
  const ready = !isDocumentEmpty(doc) || tray.length > 0 || capture !== null || carries;
  // Pickers kept behind a button show only once it is opened; the first that names `behind` speaks for the button.
  const behind = pickers.find(picker => picker.behind)?.behind;
  const shownPickers = pickers.filter(picker => isChoosable(picker) && (!picker.behind || behind?.open));


  const running = capture ? (
    <RecordingBar
      stream={capture.stream}
      active
      readElapsedMs={() => capture.elapsedMs()}
      waveformLabel={capture.source.label}
      picture={capture.source.preview === 'video'
        ? <Container className="h-16 w-28 shrink-0 overflow-hidden rounded-[var(--radius-control)]">
            <React.Suspense fallback={null}><MediaFrame stream={capture.stream} mediaType="video/webm" label={capture.source.label} muted autoPlay playsInline mirrored={capture.source.mirrored} fill /></React.Suspense>
          </Container>
        : undefined}
      actions={[
        { id: 'discard', label: words.discard, icon: 'X', onPress: discardRecording },
        { id: 'stop', label: words.stop, icon: 'Square', main: true, onPress: () => stopRecording() },
      ]}
    />
  ) : null;

  const body = (
    <Container {...getRootProps({ onPaste: (event: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length) { event.preventDefault(); addFiles(files); return; }
      const link = linkInPaste(event.clipboardData.getData('text/plain'));
      if (link) { event.preventDefault(); addLink(link); }
    } })} layout="vertical" gap="sm" width="full" className="composer" data-accepts-external-files="true" data-dragging={isDragActive ? 'true' : undefined} aria-label={words.label}>
      <input {...getInputProps()} aria-label={words.attach} />
      {isDragActive ? (
        <Container alignItems="center" justifyContent="center" width="full" padding="md" rounded="lg" border="all" background="secondary">
          <Text variant="label">{words.drop_here}</Text>
        </Container>
      ) : null}
      {waysShown ? <Text variant="label" color="muted">{words.add_to_it}</Text> : null}
      {waysShown ? <AddToIt label={words.add_to_it} ways={more.map(way => ({ ...way, disabled: disabled || busy || (capture !== null && way.id.startsWith('record:')) }))} onPress={chooseMore} /> : null}
      {tray.length ? (
        <Container role="list" aria-label={words.tray} layout="horizontal" gap="xs" wrap width="full">
          {tray.map(item => <TrayTile key={item.id} item={item} removeLabel={fill(words.remove, { name: item.file?.name ?? item.link ?? '' })} onRemove={() => remove(item.id)} />)}
        </Container>
      ) : null}
      {running}
      {context.length ? (
        <Container role="list" aria-label={words.context} layout="horizontal" gap="xs" wrap width="full" className="composer-context">
          {context.map(chip => (
            <Container key={chip.id} role="listitem" layout="horizontal" gap="xs" alignItems="center" className="composer-context-chip">
              {chip.icon ? <NamedIcon name={chip.icon} size="xs" aria-hidden="true" /> : null}
              <Text variant="caption" className="composer-context-label">{chip.label}</Text>
              {onRemoveContext ? (
                <Button type="button" variant="ghost" size="icon-xs" aria-label={fill(words.remove, { name: chip.label })} onClick={() => onRemoveContext(chip.id)}>
                  <NamedIcon name="X" size="xs" aria-hidden="true" />
                </Button>
              ) : null}
            </Container>
          ))}
        </Container>
      ) : null}
      {behind ? (
        <Container layout="horizontal" gap="xs" alignItems="center" wrap width="full" className="composer-behind">
          {pickers.some(picker => picker.behind && isChoosable(picker)) ? (
            <Button type="button" variant="ghost" size="sm" aria-expanded={behind.open} disabled={busy || disabled} onClick={behind.onToggle}>
              <NamedIcon name={behind.open ? 'ChevronUp' : 'ChevronDown'} size="xs" aria-hidden="true" />
              {behind.open ? behind.closeLabel : behind.label}
            </Button>
          ) : null}
          {pickers.map(picker => picker.behind?.status).find(Boolean) ? <Text variant="caption" color="muted" role="status">{pickers.map(picker => picker.behind?.status).find(Boolean)}</Text> : null}
        </Container>
      ) : null}
      {shownPickers.length || snippets?.rows.length || snippets?.save ? (
        <Container layout="horizontal" gap="xs" wrap width="full" className="composer-pickers">
          {shownPickers.map(picker => <PickerMenu key={picker.id} picker={picker} disabled={busy || disabled} />)}
          {snippets?.rows.length || snippets?.save ? <SnippetMenu snippets={snippets} label={words.snippets} saveLabel={words.snippet_save} written={documentToMarkdown(doc, DEFAULT_EDITING_RULES)} disabled={busy || disabled} put={words => editor.current?.insertText(words)} failed={error => setSaid({ text: errorWords(error), failed: true })} /> : null}
        </Container>
      ) : null}
      {/* The words fill the box; under them one row holds the ways to add, flush with the words' start, and Send at its
          end, as a chat input is laid out (21st.dev Input Bar 12400 and Prompt Input 28187). */}
      <Container as="form" role="form" aria-label={words.label} layout="vertical" gap="xs" width="full"
        rounded="lg" border="all" background="primary" padding="sm" position="relative" className="composer-field"
        onSubmit={(event: React.FormEvent) => { event.preventDefault(); void send(); }}>
        {/* While the message is being handled the thread travels round the box (the shared border beam). */}
        <BorderBeam on={busy} />
        <Container width="full" className="composer-words">
          <DocumentEditor ref={editor} value={doc} onChange={setDoc} ariaLabel={words.label} placeholder={words.placeholder}
            disabled={disabled || busy} enterSends onSubmit={() => void send()} claimPaste={claimsPaste}
            colourOf={kind => mentionKinds?.[kind]?.colour}
            renderChip={(ref, colour) => <RecordChip still kind={ref.kind} value={ref.value} label={ref.label} {...(colour ? { colour } : {})} {...(mentionKinds?.[ref.kind]?.icon ? { icon: mentionKinds[ref.kind]!.icon } : {})} />}
            {...(offersMentions ? { renderPicker: (request: MentionPickerRequest) => (
              <MentionMenu request={request} candidates={mentions ?? []} kinds={mentionKinds ?? {}} label={words.mention}
                allLabel={words.mention_all} {...(onMentionQuery ? { onQuery: onMentionQuery } : {})} />
            ) } : {})} />
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="end" justifyContent={waysShown ? 'end' : 'between'} width="full" className="composer-tools">
          {/* The ways to add sit bare on the box (no group frame of their own); the one under the pointer opens its name
              towards Send, which the row keeps at its end. */}
          {waysShown ? null : <ExpandableTabs mode="action" size="sm" frame="none" ariaLabel={words.more} disabled={disabled || busy} items={more} onSelect={chooseMore} />}
          <Button type="submit" variant="primary" size="icon" aria-label={words.send} disabled={disabled || busy || !ready}>
            <NamedIcon name="ArrowUp" size="sm" aria-hidden="true" />
          </Button>
        </Container>
      </Container>
      {busy ? <Text variant="caption" color="muted" role="status">{words.busy}</Text>
        : said ? (
          <Container ref={saidRef} className="composer-said">
            <Text variant="caption" color={said.failed ? 'error' : 'muted'} role={said.failed ? 'alert' : 'status'}>{said.text}</Text>
            {said.next ? (
              <LinkButton size="sm" variant="outline" render={<a href={said.next.href} {...(/^https?:/.test(said.next.href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />}>{said.next.label}</LinkButton>
            ) : null}
          </Container>
        ) : null}
    </Container>
  );

  return body;
}
