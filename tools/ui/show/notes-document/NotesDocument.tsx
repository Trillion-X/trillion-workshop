import React from 'react';
import { Container } from '../container';
import { Button } from '../coss/ui/button';
import { DEFAULT_EDITING_RULES, DocumentEditor, documentFromMarkdown, documentToMarkdown, mintBlockId } from '../../../documents';
import type { DocumentValue } from '../../../documents';

const NOTES_KEEP_AFTER_MS = 700;

/** The shared block editor for a record's markdown notes. A refused save keeps
 * the exact markdown draft and exposes a retry that sends those same words. */
export function NotesDocument({text, label, onKeep}: {text: string; label: string; onKeep: (markdown: string) => void | Promise<void>}) {
  const [doc, setDoc] = React.useState<DocumentValue>(() => documentFromMarkdown(text, DEFAULT_EDITING_RULES, mintBlockId));
  const [failed, setFailed] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const kept = React.useRef(text);
  const waiting = React.useRef<{timer: ReturnType<typeof setTimeout>; doc: DocumentValue} | null>(null);
  const failedRef = React.useRef<string | null>(null);
  const editorRevision = React.useRef(0);
  const activeWrites = React.useRef(0);
  const mounted = React.useRef(true);
  const writes = React.useRef<Promise<void>>(Promise.resolve());
  const keeper = React.useRef(onKeep);
  keeper.current = onKeep;
  const persist = React.useCallback((markdown: string) => {
    const revision = editorRevision.current;
    activeWrites.current += 1;
    if (mounted.current) setSaving(true);
    const attempt = writes.current.then(() => keeper.current(markdown));
    writes.current = attempt.then(() => undefined, () => undefined);
    return attempt.then(() => {
      if (revision !== editorRevision.current) return;
      kept.current = markdown;
      failedRef.current = null;
      if (mounted.current) setFailed(null);
    }, error => {
      if (revision === editorRevision.current) {
        failedRef.current = markdown;
        if (mounted.current) setFailed(markdown);
      }
      throw error;
    }).finally(() => {
      activeWrites.current = Math.max(0, activeWrites.current - 1);
      if (mounted.current) setSaving(activeWrites.current > 0);
    });
  }, []);
  const flush = React.useCallback(() => {
    const pending = waiting.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.current = null;
    const markdown = documentToMarkdown(pending.doc, DEFAULT_EDITING_RULES).trim();
    if (markdown === kept.current.trim()) return;
    // Auto-save owns the recovery alert; a Retry press receives the rejecting promise itself.
    void persist(markdown).catch(() => {});
  }, [persist]);
  React.useEffect(() => {
    if (waiting.current || activeWrites.current > 0 || failedRef.current !== null || text.trim() === kept.current.trim()) return;
    kept.current = text;
    setDoc(documentFromMarkdown(text, DEFAULT_EDITING_RULES, mintBlockId));
  }, [text]);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; flush(); };
  }, [flush]);
  return (
    <Container layout="vertical" padding="none" flex="1" minHeight="0" data-reach-role="record-notes"
      onClick={event => event.stopPropagation()} onBlur={flush}>
      <DocumentEditor
        value={doc}
        ariaLabel={label}
        placeholder="Add notes"
        onChange={next => {
          editorRevision.current += 1;
          failedRef.current = null;
          setFailed(null);
          setDoc(next);
          if (waiting.current) clearTimeout(waiting.current.timer);
          waiting.current = {doc: next, timer: setTimeout(flush, NOTES_KEEP_AFTER_MS)};
        }}
      />
      {failed !== null && <div className="flex items-center gap-2" role="alert">
        <span>These notes could not be saved.</span>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => persist(failed)}>Retry save</Button>
      </div>}
    </Container>
  );
}
