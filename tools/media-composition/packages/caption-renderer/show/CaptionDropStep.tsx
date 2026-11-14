import React, { useEffect } from 'react';
import { AlertTriangle, Check, FileAudio, UploadCloud } from 'lucide-react';

import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';

export type CaptionDropStepItem = {
  id: string;
  fileName: string;
  byteLength?: number;
  detail: string;
  ready: boolean;
  selected: boolean;
  error: string | null;
};

export type CaptionDiagnosticEntry = {
  id: number;
  at: string;
  event: string;
  detail: string;
};

function bytesLabel(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function filesFromList(files: FileList | null): File[] {
  return files ? Array.from(files) : [];
}

function fileSummary(files: File[]): string {
  if (files.length === 0) return '0 files';
  return files.map((file) => `${file.name} (${file.type || 'unknown type'}, ${file.size} bytes)`).join('; ');
}

function unknownErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function activeElementLabel(): string {
  if (typeof document === 'undefined') return 'document unavailable';
  const active = document.activeElement;
  if (!active) return 'none';
  const element = active as HTMLElement;
  return [element.tagName.toLowerCase(), element.id ? `#${element.id}` : '', element.getAttribute('aria-label') ? `[aria-label="${element.getAttribute('aria-label')}"]` : ''].join('');
}

function pickerEnvironment(): string {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const win = typeof window === 'undefined' ? null : window;
  const doc = typeof document === 'undefined' ? null : document;
  return [
    `url=${win?.location?.href ?? 'unavailable'}`,
    `userAgent=${nav?.userAgent ?? 'unavailable'}`,
    `platform=${nav?.platform ?? 'unavailable'}`,
    `secureContext=${win?.isSecureContext ? 'yes' : 'no'}`,
    `visibility=${doc?.visibilityState ?? 'unavailable'}`,
    `documentFocus=${doc?.hasFocus?.() ? 'yes' : 'no'}`,
    `showOpenFilePicker=${typeof (win as any)?.showOpenFilePicker === 'function' ? 'available' : 'missing'}`,
    'primaryPicker=local-files compute.process',
    'dropAccepts=audio/video',
  ].join(' | ');
}

function buttonClickDetail(event: React.MouseEvent<HTMLButtonElement>): string {
  return [
    `trusted=${event.nativeEvent.isTrusted ? 'yes' : 'no'}`,
    `detail=${event.detail}`,
    `button=${event.button}`,
    `documentFocus=${typeof document !== 'undefined' && document.hasFocus() ? 'yes' : 'no'}`,
    `active=${activeElementLabel()}`,
  ].join(' | ');
}

function DropTarget({
  onDiagnostic,
  onFiles,
  onChooseLocalFiles,
}: {
  onDiagnostic: (event: string, detail: string) => void;
  onFiles: (files: File[]) => void;
  onChooseLocalFiles: () => void | Promise<void>;
}) {
  const readFiles = (source: string, files: FileList | null) => {
    const nextFiles = filesFromList(files);
    onDiagnostic(source, fileSummary(nextFiles));
    onFiles(nextFiles);
  };

  useEffect(() => {
    onDiagnostic('diagnostics ready', pickerEnvironment());
  }, []);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      onDiagnostic('window error', `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      onDiagnostic('unhandled promise rejection', unknownErrorDetail(event.reason));
    };
    const handleFocus = () => onDiagnostic('window focus', `visibility=${document.visibilityState} | active=${activeElementLabel()}`);
    const handleBlur = () => onDiagnostic('window blur', `visibility=${document.visibilityState} | active=${activeElementLabel()}`);
    const handleVisibility = () => onDiagnostic('document visibility', document.visibilityState);
    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return (
    <Card
      variant="nested"
      padding="lg"
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => onDiagnostic('drag enter', pickerEnvironment())}
      onDrop={(event) => {
        event.preventDefault();
        readFiles('drop files', event.dataTransfer.files);
      }}
      className="border-dashed"
    >
      <Container layout="vertical" gap="md">
        <Container layout="horizontal" gap="lg" alignItems="center" justifyContent="between" wrap>
          <Container layout="horizontal" gap="md" alignItems="center" minHeight="0">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[28px] bg-status-success/15 text-status-success">
              <UploadCloud className="h-7 w-7" />
            </span>
            <Container layout="vertical" gap="xs" minHeight="0">
              <Text variant="heading">Add audio or video</Text>
              <Text variant="body-xs" color="faint" truncate>
                Drop a file here, or choose one.
              </Text>
            </Container>
          </Container>
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={(event) => {
              onDiagnostic('choose files button click', buttonClickDetail(event));
              void onChooseLocalFiles();
            }}
          >
            Choose files
          </Button>
        </Container>
      </Container>
    </Card>
  );
}

function QueueRow({
  item,
  onSelect,
}: {
  item: CaptionDropStepItem;
  onSelect: () => void;
}) {
  const Icon = item.error ? AlertTriangle : item.ready ? Check : FileAudio;

  return (
    <Card variant="nested" padding="md" interactive={item.ready} selected={item.selected} onClick={onSelect} layout="stack">
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
        <Container layout="horizontal" gap="md" alignItems="center" minHeight="0">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${item.ready ? 'bg-status-success/15 text-status-success' : item.error ? 'bg-status-warning/15 text-status-warning' : 'bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)]'}`}>
            <Icon className="h-5 w-5" />
          </span>
          <Container layout="vertical" gap="xs" minHeight="0">
            <Text variant="body-xs" weight="semibold" truncate>{item.fileName}</Text>
            <Text variant="caption" color="faint">
              {[bytesLabel(item.byteLength), item.detail].filter(Boolean).join(' / ')}
            </Text>
          </Container>
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="center">
          {item.ready && (
            <Button variant={item.selected ? 'success' : 'secondary'} size="sm" onClick={onSelect}>
              Use
            </Button>
          )}
        </Container>
      </Container>
      {item.error && <Text variant="caption" color="error">{item.error}</Text>}
    </Card>
  );
}

export function CaptionDropStep({
  items,
  error,
  onFiles,
  onChooseLocalFiles,
  onSelectItem,
  onDiagnostic = () => {},
}: {
  items: CaptionDropStepItem[];
  error: string | null;
  onFiles: (files: File[]) => void;
  onChooseLocalFiles: () => void | Promise<void>;
  onSelectItem: (id: string) => void;
  onDiagnostic?: (event: string, detail: string) => void;
}) {
  const readyCount = items.filter((item) => item.ready).length;
  const title = items.length ? `${readyCount} of ${items.length} files ready` : 'Create a captioned video.';
  const detail = items.length
    ? 'Keep this page open. Captions and video stay here.'
    : 'Choose an audio or video file. The app creates captions first.';

  return (
    <Card variant="surface" padding="lg" layout="stack" className="w-full">
      <Container layout="vertical" gap="xs">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-xl">{title}</Text>
          <Text variant="body-xs" color="faint" leading="relaxed">{detail}</Text>
        </Container>
      </Container>

      <DropTarget onDiagnostic={onDiagnostic} onFiles={onFiles} onChooseLocalFiles={onChooseLocalFiles} />

      {items.length > 0 && (
        <Container layout="vertical" gap="sm">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} onSelect={() => onSelectItem(item.id)} />
          ))}
        </Container>
      )}

      {error && (
        <Card variant="error" padding="md">
          <Text variant="body-xs" color="error">{error}</Text>
        </Card>
      )}
    </Card>
  );
}
