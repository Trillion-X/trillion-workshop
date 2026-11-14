import * as React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Input } from '../input';
import { Text } from '../text';
import { NamedIcon } from '../icon';

export type QuickCreateProps = {
  label: string;
  placeholder: string;
  submitLabel: string;
  busyLabel: string;
  errorLabel: string;
  secondaryLabel: string;
  disabled?: boolean;
  compact?: boolean;
  expandLabel?: string;
  onExpand?: () => void;
  /** A count that grows each time the caller wants the field focused (a key that jumps to it). */
  focusRequest?: number;
  /** What the typed words will do, said back under the field (a list or time they name); null says nothing. */
  preview?: (value: string) => string | null;
  onSubmit: (value: string) => Promise<boolean>;
  onSecondaryAction: () => void;
};

/** A compact shared entry point with one owner-supplied primary action and a neighboring destination. */
export function QuickCreate({ label, placeholder, submitLabel, busyLabel, errorLabel, secondaryLabel, disabled = false, compact = false, expandLabel, onExpand, focusRequest = 0, preview, onSubmit, onSecondaryAction }: QuickCreateProps) {
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const mounted = React.useRef(true);
  const submitting = React.useRef(false);
  const field = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { if (focusRequest > 0) field.current?.focus(); }, [focusRequest]);
  const previewed = preview?.(value) ?? null;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async () => {
    const text = value.trim();
    if (!text || submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true); setFailed(false);
    try {
      const kept = await onSubmit(text);
      if (!kept) throw new Error(errorLabel);
      if (mounted.current) setValue('');
    } catch (error) { if (mounted.current) setFailed(true); throw error; }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };

  return <Container layout="vertical" gap="xs" className="quick-create" data-compact={compact}>
    <Container layout="horizontal" gap="xs" alignItems="center" wrap data-quick-create-fields>
      <Input ref={field} aria-label={label} placeholder={placeholder} value={value} disabled={disabled || busy} autoComplete="off"
        onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit().catch(() => {}); } }} />
      <Button size={compact ? "icon" : "sm"} variant={compact ? "ghost" : "primary"} aria-label={busy ? busyLabel : submitLabel} disabled={disabled || busy || !value.trim()} onClick={() => submit()}>{compact ? <NamedIcon name="CornerDownLeft" size="sm" /> : busy ? busyLabel : submitLabel}</Button>
      <Button size="sm" variant="ghost" className="quick-create-secondary" disabled={disabled} onClick={onSecondaryAction}>{secondaryLabel}</Button>
      {onExpand && expandLabel ? <Button size="icon" variant="ghost" aria-label={expandLabel} disabled={disabled || busy} onClick={onExpand}><NamedIcon name="Plus" size="sm" /></Button> : null}
    </Container>
    {previewed ? <Text variant="caption" color="muted" data-quick-create-preview>{previewed}</Text> : null}
    {failed ? <Text variant="caption" color="error" role="alert">{errorLabel}</Text> : null}
  </Container>;
}
