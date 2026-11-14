import * as React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';

export type FileWorkActionProps = {
  accept: string;
  emptyTitle: React.ReactNode;
  emptyDetail: React.ReactNode;
  pickLabel: React.ReactNode;
  startLabel: React.ReactNode;
  rejectMessage: string;
  successMessage?: React.ReactNode;
  errorMessage?: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  multiple?: boolean;
  startWhenFilesAccepted?: boolean;
  showStartAction?: boolean;
  acceptsFile?: (file: File) => boolean;
  pickFiles?: () => Promise<readonly File[]> | readonly File[];
  onStart: (file: File) => Promise<void> | void;
};

function fileSizeText(file: File): string {
  if (file.size < 1024) return `${file.size} bytes`;
  if (file.size < 1024 * 1024) return `${Math.round(file.size / 102.4) / 10} KB`;
  return `${Math.round(file.size / 1024 / 102.4) / 10} MB`;
}

export function FileWorkAction({
  accept,
  acceptsFile,
  busy = false,
  disabled = false,
  emptyDetail,
  emptyTitle,
  errorMessage,
  multiple = false,
  onStart,
  pickLabel,
  pickFiles,
  rejectMessage,
  showStartAction = true,
  startLabel,
  startWhenFilesAccepted = false,
  successMessage,
}: FileWorkActionProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = React.useState<File[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [isPicking, setIsPicking] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const runFiles = React.useCallback(async (files: readonly File[]) => {
    if (files.length === 0) {
      setLocalError(rejectMessage);
      return;
    }
    setLocalError(null);
    for (const file of files) {
      await onStart(file);
    }
    setSelectedFiles([]);
  }, [onStart, rejectMessage]);

  const acceptFiles = React.useCallback((files: FileList | readonly File[]) => {
    const acceptedFiles = Array.from(files).filter((item) => acceptsFile?.(item) ?? true);
    if (acceptedFiles.length === 0) {
      setLocalError(rejectMessage);
      return;
    }
    const nextFiles = multiple ? acceptedFiles : acceptedFiles.slice(0, 1);
    setSelectedFiles(nextFiles);
    setLocalError(null);
    if (startWhenFilesAccepted) void runFiles(nextFiles);
  }, [acceptsFile, multiple, rejectMessage, runFiles, startWhenFilesAccepted]);

  const chooseFiles = React.useCallback(async () => {
    if (pickFiles) {
      setIsPicking(true);
      setLocalError(null);
      try {
        acceptFiles(await pickFiles());
      } catch (error) {
        console.error("[file-work-action] failed:", error); setLocalError(rejectMessage);
      } finally {
        setIsPicking(false);
      }
      return;
    }

    inputRef.current?.click();
  }, [acceptFiles, pickFiles, rejectMessage]);

  const start = React.useCallback(async () => {
    if (selectedFiles.length === 0) {
      setLocalError(rejectMessage);
      return;
    }
    await runFiles(selectedFiles);
  }, [rejectMessage, runFiles, selectedFiles]);

  const selectedTitle = selectedFiles.length === 0
    ? emptyTitle
    : selectedFiles.length === 1
      ? selectedFiles[0].name
      : `${selectedFiles.length} files selected`;
  const selectedDetail = selectedFiles.length === 0
    ? emptyDetail
    : selectedFiles.length === 1
      ? `${selectedFiles[0].type || 'file'} · ${fileSizeText(selectedFiles[0])}`
      : selectedFiles.map((file) => file.name).join(', ');

  return (
    <Container layout="vertical" gap="md">
      <button
        type="button"
        data-accepts-external-files="true"
        className={[
          'group flex min-h-48 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-5 py-8 text-center transition-colors',
          isDragging
            ? 'border-[var(--button-primary-bg)] bg-[var(--glass-bg-active)]'
            : 'border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] hover:bg-[var(--glass-bg-hover)]',
        ].join(' ')}
        disabled={disabled || busy || isPicking}
        onClick={() => void chooseFiles()}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <Text variant="heading-lg" leading="tight">
          {selectedTitle}
        </Text>
        <Text variant="body" color="faint">
          {selectedDetail}
        </Text>
      </button>
      {!pickFiles ? (
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(event) => {
            acceptFiles(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
          }}
        />
      ) : null}
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
        {successMessage ? (
          <Text variant="body-xs" color="success">
            {successMessage}
          </Text>
        ) : null}
        {errorMessage || localError ? (
          <Text variant="body-xs" color="error">
            {errorMessage ?? localError}
          </Text>
        ) : null}
        <Button variant="secondary" onClick={() => chooseFiles()} disabled={disabled || busy || isPicking} loading={isPicking}>
          {pickLabel}
        </Button>
        {showStartAction ? (
          <Button variant="primary" onClick={start} disabled={selectedFiles.length === 0 || disabled || busy || isPicking} loading={busy}>
            {startLabel}
          </Button>
        ) : null}
      </Container>
    </Container>
  );
}
