// parts/ui/show/mention-picker/MentionPicker.tsx
//
// PURPOSE
//   What `@` shows: the things that can be mentioned, grouped by kind under the kind's name, each with its kind's
//   icon in its kind's colour; a row of kinds above narrows the list to one kind and "All" widens it back. Typing
//   narrows it (`pickMentions`). The field that owns the caret (the message field, the document editor) keeps the
//   keyboard and hands the picker what is typed, which row is highlighted and which kind is chosen, so the picker
//   never takes focus away from the words. After Dropbox Dash's composer suggestions and Notion's @-menu on Mobbin
//   (icon, name, a muted detail, grouped under faint headers) and 21st.dev 29425 "Tabs with Count Badge" (coss) for
//   the kind row.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind: candidates and each kind's look (label, icon, colour) are the caller's DATA, and a
//      kind with no look still draws under its own key.
//   2. `pickMentions` is the one rule for what shows, in what order: the rows the highlighted index counts are the
//      rows drawn, group by group.
//   3. Pressing a row or a kind never moves focus out of the field (mouse down is held), so the caret stays put.

import React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { Text } from '../text';
import type { RecordChipKinds } from '../record-chip';
import { mentionKindsAmong, pickMentions, type MentionOption } from './pick-mentions';

export interface MentionPickerProps {
  /** Everything offered; the picker shows what `query` and `kind` leave. */
  candidates: readonly MentionOption[];
  kinds?: RecordChipKinds;
  /** The words typed after `@`. */
  query: string;
  /** The one kind shown, or null for every kind. */
  kind: string | null;
  onKindChange: (kind: string | null) => void;
  /** The highlighted row, an index into what `pickMentions` answers. */
  highlighted: number;
  onHighlight: (index: number) => void;
  onChoose: (option: MentionOption) => void;
  /** The list's accessible name. */
  label: string;
  /** The words of the choice that widens back to every kind. */
  allLabel?: string;
  /** The list's element id, for the field's aria-controls. */
  id?: string;
}

const hold = (event: React.MouseEvent) => event.preventDefault();

function KindMark({ kind, kinds }: { kind: string; kinds: RecordChipKinds }) {
  return (
    <Container alignItems="center" justifyContent="center" rounded="full" className="mention-picker-mark" data-colour={kinds[kind]?.colour}>
      <NamedIcon name={kinds[kind]?.icon ?? 'AtSign'} size="xs" aria-hidden="true" />
    </Container>
  );
}

export function MentionPicker({
  candidates, kinds = {}, query, kind, onKindChange, highlighted, onHighlight, onChoose, label, allLabel = 'All', id,
}: MentionPickerProps) {
  const shown = React.useMemo(() => pickMentions(candidates, kinds, query, kind), [candidates, kinds, query, kind]);
  const among = React.useMemo(() => mentionKindsAmong(candidates, kinds, query), [candidates, kinds, query]);
  const choices = kind !== null && !among.includes(kind) ? [...among, kind] : among;
  const list = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, shown]);
  return (
    <Container layout="vertical" gap="xs" className="mention-picker">
      {choices.length > 1 || kind !== null ? (
        <Container layout="horizontal" gap="xs" alignItems="center" role="toolbar" aria-label="Kinds" className="mention-picker-kinds">
          <Button type="button" variant="ghost" size="xs" active={kind === null} onMouseDown={hold} onClick={() => onKindChange(null)}>{allLabel}</Button>
          {choices.map(one => (
            <Button key={one} type="button" variant="ghost" size="xs" active={kind === one} data-kind={one} onMouseDown={hold} onClick={() => onKindChange(kind === one ? null : one)}>
              <NamedIcon name={kinds[one]?.icon ?? 'AtSign'} size="xs" className="mention-picker-kind-icon" data-colour={kinds[one]?.colour} aria-hidden="true" />
              {kinds[one]?.label ?? one}
            </Button>
          ))}
        </Container>
      ) : null}
      <Container ref={list} id={id} role="listbox" aria-label={label} layout="vertical" gap="none" className="mention-picker-list">
        {shown.map((option, at) => {
          const heading = at === 0 || shown[at - 1].kind !== option.kind;
          return (
            <React.Fragment key={`${option.kind}:${option.value}`}>
              {heading ? <Text variant="caption" color="faint" className="mention-picker-heading" aria-hidden="true">{kinds[option.kind]?.label ?? option.kind}</Text> : null}
              <Button type="button" role="option" aria-selected={at === highlighted} data-kind={option.kind}
                variant={at === highlighted ? 'secondary' : 'ghost'} size="sm" className="mention-picker-option"
                onMouseDown={hold} onMouseEnter={() => onHighlight(at)} onClick={() => onChoose(option)}>
                <KindMark kind={option.kind} kinds={kinds} />
                <Text variant="body" weight="semibold" truncate>{option.label}</Text>
                {option.detail ? <Text variant="caption" color="muted" truncate>{option.detail}</Text> : null}
              </Button>
            </React.Fragment>
          );
        })}
      </Container>
    </Container>
  );
}
