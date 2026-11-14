// parts/ui/show/selection-format-bar/SelectionFormatBar.tsx
//
// PURPOSE
//   A small bar of formatting buttons that appears above a plain-text field while words in it are selected, and applies a
//   mark to them (selection-format.mjs). Domain-blind: the caller passes the field, the commands as DATA rows with their
//   words and icons, and keeps the text; the bar writes nothing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pressing a button never takes the selection from the field: the press is stopped at pointer-down.
//   2. The bar exists only while the field has focus and a selection; it never hides the words it acts on.

import * as React from 'react';
import { Button } from '../coss/ui/button';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { applyFormat, type FormatCommandRow } from './selection-format.mjs';

export interface SelectionFormatCommand extends FormatCommandRow { id: string; label: string; icon: string }

export interface SelectionFormatBarProps {
  /** The text field the bar belongs to. */
  field: HTMLTextAreaElement | null;
  commands: readonly SelectionFormatCommand[];
  /** The bar's accessible name. */
  label: string;
  /** Told the new text; the caller keeps it. */
  onChange: (value: string) => void;
}

export function SelectionFormatBar({ field, commands, label, onChange }: SelectionFormatBarProps) {
  const [selected, setSelected] = React.useState(false);
  React.useEffect(() => {
    if (!field) return;
    const read = () => setSelected(document.activeElement === field && field.selectionStart !== field.selectionEnd);
    const events = ['select', 'keyup', 'mouseup', 'focus', 'blur'] as const;
    for (const name of events) field.addEventListener(name, read);
    document.addEventListener('selectionchange', read);
    return () => { for (const name of events) field.removeEventListener(name, read); document.removeEventListener('selectionchange', read); };
  }, [field]);
  if (!field || !selected) return null;
  const apply = (command: SelectionFormatCommand) => {
    const result = applyFormat(field.value, field.selectionStart, field.selectionEnd, command);
    if (result.value === field.value) return;
    onChange(result.value);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(result.start, result.end); });
  };
  return <Container layout="horizontal" gap="xs" role="toolbar" aria-label={label} className="selection-format-bar" data-selection-format-bar=""
    onPointerDown={event => event.preventDefault()}>
    {commands.map(command => <Button key={command.id} type="button" size="icon-xs" variant="ghost" aria-label={command.label} title={command.label} onClick={() => apply(command)}>
      <NamedIcon name={command.icon} size="xs" aria-hidden />
    </Button>)}
  </Container>;
}
