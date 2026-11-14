import { useEffect, useRef, useState } from 'react';

/** Share successful and in-flight downloads; a refused attempt can always be tried again. */
export function retryableEditorDownload<T>(download: () => Promise<T>, source?: string): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(() => prepareModule(source)).then(download).catch(error => { pending = null; throw error; });
    return pending;
  };
}

/** Download completion is not canvas readiness. Only the editor reports ready after its page paints. */
export function useEditorDownload<T>(download: () => Promise<T>, onReady?: (ready: boolean) => void) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; status: 'loading' | 'failed' | 'loaded'; value?: T }>({ attempt: 0, status: 'loading' });
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let gone = false;
    ready.current?.(false);
    void Promise.resolve().then(download).then(value => {
      if (!gone) setResult({ attempt, status: 'loaded', value });
    }, () => {
      if (!gone) setResult({ attempt, status: 'failed' });
    });
    return () => { gone = true; ready.current?.(false); };
  }, [download, attempt]);
  return { ...(result.attempt === attempt ? result : { status: 'loading' as const, value: undefined }), retry: () => setAttempt(value => value + 1) };
}

/** Read this document's build graph before import(), which browsers can cache as failed after a network refusal. */
async function prepareModule(source?: string) {
  if (!source || typeof document === 'undefined') return;
  const element = document.getElementById('trillion-module-downloads');
  if (!element) return; // Isolated component hosts may supply their own download function.
  const graph = JSON.parse(element.textContent || '{}') as Record<string, string[]>;
  const files = graph[source];
  if (!Array.isArray(files) || !files.length) throw new Error('The page editor download could not be prepared.');
  for (const file of files) {
    const url = new URL(file, location.href);
    if (url.origin !== location.origin || !file.startsWith('/') || file.startsWith('//')) throw new Error('The page editor download address is invalid.');
    const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('The page editor download could not finish.');
    await response.arrayBuffer();
  }
}
