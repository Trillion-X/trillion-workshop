import * as React from 'react';
import { Container, Text } from '../../ui';

export type MeetingNoteMetadataRow = { id: string; label: string; value?: string; content?: React.ReactNode };

/** The note's own facts as label and value rows (Created, Updated, Audio). A row says its `value` or holds its own `content` (the player). The caller owns what the rows say and their words. */
export function MeetingNoteMetadata({ rows, ariaLabel }: { rows: readonly MeetingNoteMetadataRow[]; ariaLabel: string }): React.ReactElement {
  return <Container layout="vertical" gap="xs" padding="sm" aria-label={ariaLabel}>
    {rows.map(row => <Container key={row.id} layout="horizontal" gap="sm" alignItems="baseline">
      <Text variant="body" color="subtle">{row.label}</Text>
      {row.content ?? <Text variant="body" color="strong">{row.value}</Text>}
    </Container>)}
  </Container>;
}
