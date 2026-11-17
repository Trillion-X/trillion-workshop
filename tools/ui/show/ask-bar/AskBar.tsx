import React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { ExpandableTabs } from '../expandable-tabs';
import { NamedIcon } from '../icon';
import { Textarea } from '../input';
import { Text } from '../text';

export interface AskBarSuggestion {
  id: string;
  label: string;
  prompt?: string;
}

export interface AskBarProps {
  ariaLabel?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  suggestions?: readonly AskBarSuggestion[];
  onValueChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttach?: () => void;
  onVoice?: () => void;
  /** More actions beside the field ("Import an export"), drawn with attach and voice. */
  actions?: readonly { id: string; label: string; icon: string }[];
  onAction?: (id: string) => void;
  /** Named icon at the start of the bar; the default marks asking. */
  leadingIcon?: string;
  /** What the send button does, for people using a screen reader ("Add links"). */
  submitLabel?: string;
  disabled?: boolean;
  busy?: boolean;
}

export const AskBar = React.forwardRef<HTMLTextAreaElement, AskBarProps>(function AskBar({
  ariaLabel = 'Ask anything',
  value,
  defaultValue = '',
  placeholder = 'Ask anything',
  suggestions = [],
  onValueChange,
  onSubmit,
  onAttach,
  onVoice,
  actions = [],
  onAction,
  leadingIcon = 'Sparkles',
  submitLabel = 'Submit question',
  disabled = false,
  busy = false,
}, forwardedRef) {
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const localRef = React.useRef<HTMLTextAreaElement | null>(null);
  const controlled = value !== undefined;
  const currentValue = controlled ? value : internalValue;

  const setFieldRef = React.useCallback((node: HTMLTextAreaElement | null) => {
    localRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const updateValue = React.useCallback((next: string) => {
    if (!controlled) setInternalValue(next);
    onValueChange?.(next);
  }, [controlled, onValueChange]);

  const submit = React.useCallback(() => {
    const trimmed = currentValue.trim();
    if (!trimmed || disabled || busy) return;
    onSubmit(trimmed);
  }, [busy, currentValue, disabled, onSubmit]);

  return (
    <Container layout="vertical" gap="md" width="full">
      <Container
        as="form"
        role="search"
        aria-label={ariaLabel}
        layout="horizontal"
        gap="sm"
        alignItems="center"
        width="full"
        rounded="full"
        border="all"
        background="primary"
        padding="sm"
        className="shadow-[0_10px_30px_rgba(46,35,85,0.08)]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Container
          alignItems="center"
          justifyContent="center"
          rounded="full"
          className="h-9 w-9 shrink-0 bg-[var(--accent-primary)] text-white"
          aria-hidden="true"
        >
          <NamedIcon name={leadingIcon} size="sm" />
        </Container>
        <Textarea
          ref={setFieldRef}
          aria-label={ariaLabel}
          value={currentValue}
          placeholder={placeholder}
          disabled={disabled}
          autoGrow
          maxHeight={128}
          rows={1}
          className="min-h-10 flex-1 resize-none border-0 bg-transparent px-1 py-2 text-[length:var(--font-size-body-lg)] shadow-none focus-visible:ring-0"
          onChange={(event) => updateValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        {onAttach || onVoice || actions.length ? (
          <ExpandableTabs
            mode="action"
            size="sm"
            ariaLabel="More ways to add"
            disabled={disabled || busy}
            items={[
              ...(onAttach ? [{ id: 'attach', label: 'Attach context', icon: 'Paperclip' }] : []),
              ...(onVoice ? [{ id: 'voice', label: 'Use voice input', icon: 'Mic' }] : []),
              ...actions,
            ]}
            onSelect={(id) => (id === 'attach' ? onAttach?.() : id === 'voice' ? onVoice?.() : onAction?.(id))}
          />
        ) : null}
        <Button type="submit" variant="primary" size="icon" aria-label={submitLabel} disabled={disabled || busy || currentValue.trim().length === 0}>
          <NamedIcon name="ArrowUp" size="sm" aria-hidden="true" />
        </Button>
      </Container>
      {suggestions.length > 0 ? (
        <Container role="list" aria-label="Suggested prompts" layout="horizontal" gap="xs" justifyContent="center" wrap>
          {suggestions.map((suggestion) => (
            <Container key={suggestion.id} role="listitem">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-1 text-[var(--text-muted)]"
                disabled={disabled || busy}
                onClick={() => {
                  updateValue(suggestion.prompt ?? suggestion.label);
                  localRef.current?.focus();
                }}
              >
                <Text variant="caption" color="faint">{suggestion.label}</Text>
              </Button>
            </Container>
          ))}
        </Container>
      ) : null}
      {busy ? <Text role="status" aria-live="polite" className="sr-only">Submitting question</Text> : null}
    </Container>
  );
});

AskBar.displayName = 'AskBar';
