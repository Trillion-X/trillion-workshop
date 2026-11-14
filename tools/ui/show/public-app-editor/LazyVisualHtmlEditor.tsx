import downloads from './module-downloads.json';
import React from 'react';
import { ErrorBoundary } from '../error-boundary';
import { ScreenState } from '../screen-state';
import { retryableEditorDownload, useEditorDownload } from './editor-download';
import type { VisualHtmlEditor as LoadedEditor, VisualHtmlEditorHandle } from './VisualHtmlEditor';

// Keep the large editor out of the Sites list until a page is opened.
const loadEditor = retryableEditorDownload(() => import('./VisualHtmlEditor').then(module => module.VisualHtmlEditor), downloads.editor);

export const LazyVisualHtmlEditor = React.forwardRef<VisualHtmlEditorHandle, React.ComponentPropsWithoutRef<typeof LoadedEditor>>((props, ref) => {
  const download = useEditorDownload(loadEditor, props.onReady);
  if (download.status === 'failed') return <ScreenState state={{ status: 'failed', title: 'The page editor could not open', description: 'Your page is still here. Try opening the editor again.', retry: { label: 'Try again', run: download.retry } }} />;
  const Editor = download.value;
  if (!Editor) return <ScreenState state={{ status: 'loading', label: 'Opening the page editor', layout: 'editor' }} />;
  return <ErrorBoundary zoneName="Page editor" fallback={(_error, retry) => <ScreenState state={{ status: 'failed', title: 'The page editor could not open', description: 'Your page is still here. Try opening the editor again.', retry: { label: 'Try again', run: retry } }} />}>
    <Editor {...props} ref={ref} />
  </ErrorBoundary>;
});
