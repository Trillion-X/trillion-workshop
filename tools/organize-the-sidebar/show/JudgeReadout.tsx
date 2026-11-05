// packages/group/show/JudgeReadout.tsx
//
// R13 product surface: the judge's verdict on a piece of writing. Shows the overall score
// (0-100) and a per-criterion bar for each rubric criterion, coloured by how well it scored.
// Reads a pure JudgeResult (writing-judge.ts) — no engine. Generic: it renders whatever
// criteria the rubric produced, never naming one (L090). Bar width/colour are data-driven
// (the score IS the value being visualised); chrome is ui components (L065).

import { Container, Text } from '../../ui/index.ts';
import type { JudgeResult } from '../read-data/writing-judge.ts';

const BAR_W = 180;

function scoreColor(score: number): string {
  if (score >= 0.75) return '#12a150';
  if (score >= 0.5) return '#d97706';
  return '#e5484d';
}

export interface JudgeReadoutProps {
  readonly result: JudgeResult;
  readonly title?: string;
}

export function JudgeReadout({ result, title }: JudgeReadoutProps): JSX.Element {
  return (
    <Container layout="vertical" gap="sm">
      {title ? (
        <Text variant="body-md" weight="semibold">
          {title}
        </Text>
      ) : null}
      <Container layout="horizontal" gap="xs" alignItems="center">
        <Text variant="heading-sm" weight="bold">
          {Math.round(result.overall * 100)}
        </Text>
        <Text variant="body-sm" tone="muted">
          / 100 overall
        </Text>
      </Container>
      {result.breakdown.map((c) => (
        <Container key={c.id} layout="vertical" gap="none">
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Text variant="body-sm">{c.label}</Text>
            <Text variant="body-sm" tone="muted">
              {Math.round(c.score * 100)}
            </Text>
          </Container>
          <Container position="relative" style={{ height: 6, width: BAR_W, background: '#e6e8ec', borderRadius: 3 }}>
            <Container
              position="absolute"
              style={{ left: 0, top: 0, height: 6, width: BAR_W * c.score, background: scoreColor(c.score), borderRadius: 3 }}
            />
          </Container>
        </Container>
      ))}
    </Container>
  );
}
