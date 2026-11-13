// src/workspace/media-edit/send-to-editor.tsx
//
// The media editor's Send to editor panel: Filmcraft prepares an editable project in one app session,
// admitting the person's mounted Namespace sources in place, and the video they export there comes back as
// the edit's finished version.
//
// Invariants
//   1. Both jobs run the account tools every AI runs (src/work-media-editor.mjs → src/editor-handoff.mjs); the panel
//      only gathers choices and shows the tool's own words.
//   2. Editor and speed choices are DATA (src/editor-handoff.json); the generic app-job owner admits sources.
//   3. Saved choices from retired editors cannot select an old editor. A queued job is followed through current
//      store changes and only an accepted, saved Filmcraft project offers Open. Retries reuse the same press.
//   4. Every control is a shared part (Container, Text, Button, Select, Input, Dropzone).

import { openFile } from '../open-screen';
import React from 'react';
import { Button, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, downloadBlob } from '../../../parts/ui';
import { LazyDropzone as Dropzone, LazyDropzoneEmptyState as DropzoneEmptyState } from '../../../parts/ui/show/kibo/LazyDropzone';
import handoff from '../../editor-handoff.json';
import { postJson, readFileBytes, readJson } from '../api';
import { uploadFiles } from '../upload';
import type { MediaEditPanelProps } from './panel-types';
import { AI_WORK, onStoreChange } from '../store-changes';

import { errorWords } from '../../../../../ui/show/safe-error-card/sanitize-error-text.ts';
export type Choices = { editor: string; frameRate: number };
type Sent = { state: string; task_id: string; file?: { identity: string; name: string }; editor: string; open_steps: string; left_out: string[]; said: string };
type Finished = { identity: string; name: string | null; attached_at: string };
type Run<T> = { state?: string; output?: T; error?: string };
type Option = { value: string; label: string };

const firstRate = handoff.frame_rates.find(rate => 'default' in rate && rate.default) ?? handoff.frame_rates[0];
const defaults = (): Choices => ({ editor: handoff.editors[0].id, frameRate: firstRate.value });

// A tool run's result, or its own words when it did not finish.
function resultOf<T>(run: Run<T>): T {
  if (run.state === 'completed' && run.output) return run.output;
  throw new Error(run.error ?? 'This did not finish. Try again.');
}

const openInFiles = (identity: string, title: string) => openFile({ id: identity, name: title });
const lastPart = (name: string) => name.split('/').pop() ?? name;

/** One labelled choice from a DATA list. */
function Choice({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (value: string) => void }) {
  return <Container layout="vertical" gap="xs">
    <Text as="span" variant="caption" color="muted">{label}</Text>
    <Select value={value} onValueChange={next => { if (typeof next === 'string') onChange(next); }}>
      <SelectTrigger aria-label={label}><SelectValue>{options.find(option => option.value === value)?.label}</SelectValue></SelectTrigger>
      <SelectPopup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
    </Select>
  </Container>;
}

export function SendToEditor({ editId, panelState, setPanelState }: MediaEditPanelProps<Choices>) {
  const choices = { ...defaults(), ...(panelState ?? {}) };
  const editor = handoff.editors.find(row => row.id === choices.editor) ?? handoff.editors[0];
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [sent, setSent] = React.useState<Sent | null>(null);
  const [finished, setFinished] = React.useState<Finished | null>(null);
  const choose = (next: Partial<Choices>) => setPanelState({ ...choices, ...next });
  const currentEdit = React.useRef(editId);
  currentEdit.current = editId;
  const press = React.useRef<{ edit: string; rate: number; key: string } | null>(null);
  const changes = React.useRef(0);
  const pending = sent !== null && !['completed', 'failed', 'canceled'].includes(sent.state);

  React.useEffect(() => {
    let live = true;
    let reads = 0;
    setSent(null); setFinished(null); setStatus(''); setBusy(false); press.current = null;
    const read = async () => {
      const reading = ++reads, revision = changes.current;
      try {
        const [answer, delivery] = await Promise.all([
          readJson<{ finished: Finished | null }>(`/work/api/media/finished?edit=${encodeURIComponent(editId)}`),
          readJson<{ sent: Sent | null }>(`/work/api/media/send-to-editor?edit=${encodeURIComponent(editId)}`),
        ]);
        if (!live || reading !== reads || revision !== changes.current) return;
        setFinished(answer.finished); setSent(delivery.sent);
        if (delivery.sent) setStatus(delivery.sent.said);
        if (delivery.sent && ['completed', 'failed', 'canceled'].includes(delivery.sent.state)) press.current = null;
      } catch (error) { if (live && reading === reads && revision === changes.current) setStatus(errorWords(error)); }
    };
    void read();
    const stop = onStoreChange(read, AI_WORK);
    return () => { live = false; stop(); };
  }, [editId]);

  const send = async () => {
    if (busy || pending) return;
    const sendingEdit = editId;
    changes.current += 1;
    if (!press.current || press.current.edit !== editId || press.current.rate !== choices.frameRate) press.current = { edit: editId, rate: choices.frameRate, key: crypto.randomUUID() };
    setBusy(true); setStatus(''); setSent(null);
    try {
      const result = resultOf(await postJson<Run<Sent>>('/work/api/media/send-to-editor', { edit: editId, editor: editor.id, frame_rate: choices.frameRate, request_key: press.current.key }));
      if (currentEdit.current !== sendingEdit) return;
      setSent(result);
      setStatus(result.said);
      if (['completed', 'failed', 'canceled'].includes(result.state)) press.current = null;
    } catch (error) { if (currentEdit.current === sendingEdit) setStatus(errorWords(error)); }
    finally { if (currentEdit.current === sendingEdit) setBusy(false); }
  };

  const download = async () => {
    if (!sent?.file) return;
    const bytes = await readFileBytes(sent.file.identity, 512 * 1024 * 1024).catch(() => null);
    if (!bytes) { setStatus('The Filmcraft project could not be read. Open it in Files instead.'); return; }
    downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>]), lastPart(sent.file.name));
  };

  const bringBack = async (files: File[]) => {
    const [video] = files;
    if (!video || busy) return;
    const finishingEdit = editId;
    changes.current += 1;
    setBusy(true); setStatus(`Adding ${video.name}…`);
    try {
      const [kept] = await uploadFiles([video], `/edits/${editId}`);
      if (!kept) throw new Error('The video could not be added. Try again.');
      const result = resultOf(await postJson<Run<{ finished: Finished; said: string }>>('/work/api/media/finished', { edit: editId, file: kept.name }));
      if (currentEdit.current !== finishingEdit) return;
      setFinished(result.finished);
      setStatus(result.said);
    } catch (error) { if (currentEdit.current === finishingEdit) setStatus(errorWords(error)); }
    finally { if (currentEdit.current === finishingEdit) setBusy(false); }
  };

  return <Container data-media-edit-panel="send-to-editor" layout="vertical" gap="lg">
    <Container layout="vertical" gap="sm">
      <Text as="h2" variant="label">Send to your video editor</Text>
      <Container layout="horizontal" gap="sm" wrap="wrap">
        <Choice label="Timeline speed" value={String(choices.frameRate)} options={handoff.frame_rates.map(rate => ({ value: String(rate.value), label: rate.label }))} onChange={value => choose({ frameRate: Number(value) })} />
      </Container>
      <Text variant="body-xs" color="muted">Filmcraft opens the source files from your connected Namespace on your computer.</Text>
      <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
        <Button size="sm" variant="primary" disabled={busy || pending} onClick={() => send()}>{busy || pending ? 'Working…' : `Send to ${editor.label}`}</Button>
        <Text as="span" variant="caption" color="muted">Sends the edit as you last saved it.</Text>
      </Container>
      {sent?.file ? <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" wrap="wrap">
          <Button size="xs" variant="secondary" onClick={() => download()}>Download project</Button>
          <Button size="xs" variant="ghost" onClick={() => { if (sent.file) openInFiles(sent.file.identity, lastPart(sent.file.name)); }}>Open in Files</Button>
        </Container>
        {sent.left_out.length ? <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">Not in the timeline file</Text>
          {sent.left_out.map(line => <Text key={line} variant="body-xs">{line}</Text>)}
        </Container> : null}
      </Container> : null}
    </Container>
    <Container layout="vertical" gap="sm">
      <Text as="h2" variant="label">Finished version</Text>
      {finished ? <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
        <Text as="span" variant="body-xs">{finished.name ? lastPart(finished.name) : 'Your finished video'}</Text>
        <Button size="xs" variant="ghost" onClick={() => openInFiles(finished.identity, finished.name ? lastPart(finished.name) : 'Finished video')}>Open</Button>
      </Container> : <Text variant="body-xs" color="muted">When you export the video from your editor, add it here and it becomes this edit's finished version.</Text>}
      <Dropzone accept={{ 'video/*': [] }} maxFiles={1} disabled={busy} onDrop={files => void bringBack(files)} onError={error => setStatus(errorWords(error, 'Choose a video file.'))} aria-label="Add the exported video">
        <DropzoneEmptyState><Text as="span" variant="body-xs">{finished ? 'Add a newer export' : 'Add the exported video'}</Text></DropzoneEmptyState>
      </Dropzone>
    </Container>
    <Text variant="body-xs" color="muted" role="status">{status}</Text>
  </Container>;
}

