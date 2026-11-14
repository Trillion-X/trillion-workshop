import * as React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import {
  emitPlaceableSurfaceIntent,
  type PlaceableSurfacePayload,
} from '../placeable-surface-intent/placeable-surface-intent';

export type OpenSurfaceActionProps = {
  payload: PlaceableSurfacePayload;
  label: string;
  detail?: string;
  unavailableMessage?: string;
  compact?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline';
  ariaLabel?: string;
  appearance?: 'default' | 'row';
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
  tabIndex?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
};

export function OpenSurfaceAction({
  detail,
  label,
  payload,
  unavailableMessage = 'Open it from Things.',
  compact = false,
  size = 'lg',
  variant = 'primary',
  ariaLabel,
  appearance = 'default',
  leading,
  trailing,
  buttonRef,
  tabIndex,
  onKeyDown,
}: OpenSurfaceActionProps) {
  const [message, setMessage] = React.useState<string | null>(null);

  const openSurface = React.useCallback(() => {
    const accepted = emitPlaceableSurfaceIntent(payload);
    setMessage(accepted ? null : unavailableMessage);
  }, [payload, unavailableMessage]);

  const rowAppearance = appearance === 'row';
  return (
    <Container
      layout={compact || rowAppearance ? 'horizontal' : 'vertical'}
      gap={compact || rowAppearance ? 'none' : 'sm'}
      alignItems={compact || rowAppearance ? 'center' : undefined}
    >
      <Button
        ref={buttonRef}
        type="button"
        variant={rowAppearance ? 'plain' : variant}
        size={rowAppearance ? 'option-row' : size}
        fullWidth={rowAppearance}
        aria-label={ariaLabel ?? (compact ? label : undefined)}
        onClick={openSurface}
        onKeyDown={onKeyDown}
        tabIndex={tabIndex}
      >
        {leading}
        <span className={rowAppearance ? 'min-w-0 flex-1 truncate text-left' : undefined}>{label}</span>
        {trailing}
      </Button>
      {detail ? (
        <Text variant="body" color="muted">
          {detail}
        </Text>
      ) : null}
      {message ? (
        <Text variant="body" color="warning">
          {message}
        </Text>
      ) : null}
    </Container>
  );
}
