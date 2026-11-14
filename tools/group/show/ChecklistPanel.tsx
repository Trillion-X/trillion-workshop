// packages/group/show/ChecklistPanel.tsx
//
// The product surface for the checklist primitive (read-data/board-checklist): a popover that turns an
// item into a checklist — a progress bar + each step as a toggle row (done crosses it out via muted
// tone) + an add-a-step input. Generic + DATA-driven: it renders whatever checklist it is handed and
// emits toggle/add/remove; the mount owns the draft + commits the mutations. L065: ui components only
// (the done toggle is a Button with a box glyph — there is no plain Checkbox in the ui barrel).

import { Button, Card, Container, Input, ProgressBar, Text } from '../../ui';
import { type Checklist, checklistProgress } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-checklist.ts';

export interface ChecklistPanelProps {
  readonly checklist: Checklist;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onToggle: (stepId: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (stepId: string) => void;
  readonly onClose: () => void;
}

const BOX_EMPTY = '☐'; // empty ballot box
const BOX_DONE = '☑'; // ballot box with check

export function ChecklistPanel({
  checklist,
  draft,
  onDraftChange,
  onToggle,
  onAdd,
  onRemove,
  onClose,
}: ChecklistPanelProps): JSX.Element {
  const progress = checklistProgress(checklist);
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="sm" style={{ minWidth: 260, maxWidth: 320 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Checklist</Text>
          <Text variant="body-sm" tone="muted">{`${progress.done}/${progress.total}`}</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close checklist panel">Close</Button>
        </Container>

        {progress.total > 0 ? (
          <ProgressBar
            percentage={progress.fraction * 100}
            color={progress.complete ? 'var(--color-success, #16a34a)' : 'var(--accent-primary, #3b6fe0)'}
          />
        ) : null}

        {checklist.length === 0 ? (
          <Text variant="body-sm" tone="muted">No steps yet. Break this down into actions.</Text>
        ) : (
          checklist.map((s) => (
            <Container key={s.id} layout="horizontal" gap="sm" alignItems="center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onToggle(s.id)}
                aria-label={s.done ? `Mark "${s.text}" not done` : `Mark "${s.text}" done`}
              >
                {s.done ? BOX_DONE : BOX_EMPTY}
              </Button>
              <Container style={{ flex: 1 }}>
                <Text variant="body-sm" tone={s.done ? 'muted' : undefined}>{s.text}</Text>
              </Container>
              <Button variant="ghost" size="sm" onClick={() => onRemove(s.id)} aria-label={`Remove "${s.text}"`}>×</Button>
            </Container>
          ))
        )}

        <Container layout="horizontal" gap="sm" alignItems="center">
          <Input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder="Add a step"
            aria-label="Add a checklist step"
          />
          <Button variant="primary" size="sm" onClick={onAdd} disabled={draft.trim() === ''} aria-label="Add step">Add</Button>
        </Container>
      </Container>
    </Card>
  );
}
