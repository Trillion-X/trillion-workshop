import * as React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { Textarea } from '../input';

export type TextWorkActionProps = {
  emptyTitle: React.ReactNode;
  emptyDetail: React.ReactNode;
  placeholder: string;
  startLabel: React.ReactNode;
  rejectMessage: string;
  successMessage?: React.ReactNode;
  errorMessage?: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  disabledMessage?: React.ReactNode;
  onStart: (text: string) => Promise<void> | void;
};

export function TextWorkAction({
  busy = false,
  disabled = false,
  disabledMessage,
  emptyDetail,
  emptyTitle,
  errorMessage,
  onStart,
  placeholder,
  rejectMessage,
  startLabel,
  successMessage,
}: TextWorkActionProps) {
  const [text, setText] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const trimmedText = text.trim();

  const start = React.useCallback(async () => {
    if (!trimmedText) {
      setLocalError(rejectMessage);
      return;
    }
    setLocalError(null);
    await onStart(trimmedText);
    setText('');
  }, [onStart, rejectMessage, trimmedText]);

  return (
    <Container layout="vertical" gap="md">
      <Container layout="vertical" gap="xs">
        <Text variant="heading-lg" leading="tight">
          {emptyTitle}
        </Text>
        <Text variant="body" color="faint">
          {emptyDetail}
        </Text>
      </Container>
      <Textarea
        placeholder={placeholder}
        value={text}
        rows={6}
        disabled={disabled || busy}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setLocalError(null);
        }}
      />
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
        {disabled && disabledMessage ? (
          <Text variant="body-xs" color="warning">
            {disabledMessage}
          </Text>
        ) : null}
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
        <Button
          variant="primary"
          onClick={start}
          disabled={!trimmedText || disabled || busy}
          loading={busy}
        >
          {startLabel}
        </Button>
      </Container>
    </Container>
  );
}
