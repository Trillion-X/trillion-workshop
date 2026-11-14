// parts/ui/show/record-picker/LinkCell.tsx
//
// PURPOSE
//   A list's link cell made editable: the rows a row links to, each as the shared record chip with a Remove press, and
//   the record picker beneath to add one more from the list the field links to. Every change is the whole new set of
//   linked row ids, handed to the caller to save (a list's rows write, the same save a typed cell uses).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list: `from` (the list the field links to) and the rows come from the caller.
//   2. A link names a row once: choosing a row already linked changes nothing.
//   3. Removing or adding saves the whole set at once, so two quick changes can never drop each other.
//   4. Every press is a real button, so keyboard and touch work as in the record picker.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { RecordChip } from '../record-chip';
import { RecordPicker, recordPickerWords, type RecordPickerWords } from './RecordPicker';
import { parseRecord, type RecordFrom, type RecordSource } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';

export type LinkedRow = { id: string; title: string };
export type LinkCellProps = {
  name: string;
  label: string;
  links: readonly LinkedRow[];
  from: RecordFrom;
  source: RecordSource;
  onChange: (ids: string[]) => void;
  words?: Partial<RecordPickerWords>;
};

export function LinkCell({ name, label, links, from, source, onChange, words }: LinkCellProps) {
  const said = { ...recordPickerWords, ...words };
  const ids = links.map(link => link.id);
  return (
    <Container layout="vertical" gap="xs" className="record-picker-links" data-slot="link-cell">
      {links.map(link => (
        <Container key={link.id} layout="horizontal" gap="xs" alignItems="center" className="record-picker-chosen">
          <RecordChip kind={from.lists?.[0] ?? 'row'} value={link.id} label={link.title} icon="List" still />
          <Button type="button" variant="ghost" size="xs" className="record-picker-remove" aria-label={`${said.remove} ${link.title}`}
            onClick={() => onChange(ids.filter(id => id !== link.id))}>
            <NamedIcon name="X" size="xs" aria-hidden="true" />{said.remove}
          </Button>
        </Container>
      ))}
      <RecordPicker name={name} label={label} placeholder={label} from={from} source={source} value="" words={words}
        onChange={value => { const row = parseRecord(value); if (row && !ids.includes(row.id)) onChange([...ids, row.id]); }} />
    </Container>
  );
}
