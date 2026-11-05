// packages/group/show/QuestionsPanel.tsx
//
// The "Questions" lens panel — the board's OPEN THREADS made first-class. On a brainstorm / research / vision
// board the questions ("What is our pricing?", "How do we onboard?") are buried in card prose; board-questions
// pulls every interrogative line, and this lists them as jumpable rows (click a question → jump to the card that
// asks it). BLIND (L090): it renders the `CardQuestions[]` it is handed, one row per question, naming no card.
// Distinct from every other lens — Readiness is dependencies, Outline is structure, Health is hygiene; this is
// the GRAMMAR of the content: "what have I not answered yet?".
import { Badge, Button, Card, Container, Text } from '../../ui/index.ts';
import type { CardQuestions } from '../read-data/board-questions.ts';

export interface QuestionsPanelProps {
  readonly cards: readonly CardQuestions[];
  /** Called with the card id of the question that was clicked — the board jumps to + frames that card. */
  readonly onJumpTo: (cardId: string) => void;
  readonly onClose: () => void;
}

export function QuestionsPanel({ cards, onJumpTo, onClose }: QuestionsPanelProps): JSX.Element {
  const total = cards.reduce((n, c) => n + c.questions.length, 0);
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="md" style={{ minWidth: 260, maxWidth: 340 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Open questions</Text>
          <Badge variant="neutral" size="sm">{String(total)}</Badge>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close open questions panel">Close</Button>
        </Container>
        {total === 0 ? (
          <Text variant="body-sm">No open questions — nothing on this board reads as a question.</Text>
        ) : (
          <Container layout="vertical" gap="xs">
            {cards.flatMap((c) =>
              c.questions.map((q, i) => (
                <Button
                  key={`${c.cardId}-${i}`}
                  variant="ghost"
                  size="sm"
                  aria-label={`Jump to the card asking: ${q}`}
                  onClick={() => onJumpTo(c.cardId)}
                >
                  <Text variant="body-sm">{q}</Text>
                </Button>
              )),
            )}
          </Container>
        )}
      </Container>
    </Card>
  );
}
